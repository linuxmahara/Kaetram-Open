import _ from 'lodash';

import { Modules } from '@kaetram/common/network';
import Utils from '@kaetram/common/util/utils';

import mapData from '../../../data/map/world.json';
import Objects from '../../info/objects';
import AreasIndex from './areas';
import Grids from './grids';
import Regions from './regions';

import type { ProcessedArea, ProcessedMap } from '@kaetram/common/types/map';
import type Entity from '../entity/entity';
import type World from '../world';
import type Areas from './areas/areas';

let map = mapData as ProcessedMap;

interface Door {
    x: number;
    y: number;
    orientation: number | undefined;
}

export type RotatedTile = { tileId: number; h: boolean; v: boolean; d: boolean }; //horizontal, vertical, diagonal
export type AnimatedTile = { tileId: string; name: string };
export type ParsedTile = RotatedTile | Tile | RotatedTile[];
export type Tile = number | number[];
export type Position = { x: number; y: number };

export default class Map {
    public regions: Regions;
    public grids: Grids;

    // Map versioning and information
    public version = map.version;
    public width = map.width;
    public height = map.height;
    public tileSize = map.tileSize;

    // Map data and collisions
    private data: (number | number[])[] = map.data;
    private collisions: number[] = map.collisions || [];
    private entities: { [tileId: number]: string } = map.entities;

    public high: number[] = map.high || [];
    public lights!: ProcessedArea[];
    public plateau!: { [index: number]: number };
    public objects!: number[];
    public cursors!: { [tileId: number]: string };
    public doors!: { [index: number]: Door };
    public warps!: ProcessedArea[];

    private areas!: { [name: string]: Areas };

    private checksum!: string;

    private readyInterval!: NodeJS.Timeout | null;
    private readyCallback?: () => void;

    public constructor(public world: World) {
        this.load();

        this.regions = new Regions(this);
        this.grids = new Grids(this);
    }

    load(): void {
        this.lights = map.areas.lights;
        this.plateau = map.plateau;
        this.objects = map.objects;
        this.cursors = map.cursors;
        this.warps = map.areas.warps;

        this.checksum = Utils.getChecksum(JSON.stringify(map));

        this.areas = {};

        this.loadAreas();
        this.loadDoors();

        this.readyCallback?.();
    }

    private loadAreas(): void {
        _.each(map.areas, (area, key: string) => {
            if (!(key in AreasIndex)) return;

            this.areas[key] = new AreasIndex[key as keyof typeof AreasIndex](area, this.world);
        });
    }

    private loadDoors(): void {
        this.doors = {};

        let doorsClone = _.cloneDeep(map.areas.doors);

        _.each(map.areas.doors, (door) => {
            // If a door somehow doesn't contain a destination.
            if (!door.destination) return;

            let index = this.coordToIndex(door.x, door.y),
                destination = _.find(doorsClone, (cloneDoor) => {
                    return door.id === cloneDoor.destination;
                });

            if (!destination) return;

            this.doors[index] = {
                x: destination.x,
                y: destination.y,
                orientation: destination.orientation
            };
        });
    }

    /**
     * Converts a coordinate (x and y) into an array index.
     * @returns Index position relative to a 1 dimensional array.
     */

    public coordToIndex(x: number, y: number): number {
        return y * this.width + x;
    }

    /**
     * Works in reverse to `coordToIndex`. Takes an index
     * within a one dimensional array and returns the
     * coordinate variant of that index.
     * @param index The index of the coordinate
     */

    public indexToCoord(index: number): Position {
        return {
            x: index % this.width,
            y: Math.floor(index / this.width)
        };
    }

    /**
     * Checks whether a tileId is flipped or not by comparing
     * the value against the lowest flipped bitflag.
     * @param tileId The tileId we are checking.
     */

    public isFlipped(tileId: number): boolean {
        return tileId > Modules.Constants.DIAGONAL_FLAG;
    }

    private inArea(
        posX: number,
        posY: number,
        x: number,
        y: number,
        width: number,
        height: number
    ): boolean {
        return posX >= x && posY >= y && posX <= width + x && posY <= height + y;
    }

    public inTutorialArea(entity: Entity): boolean {
        if (entity.x === -1 || entity.y === -1) return true;

        return (
            this.inArea(entity.x, entity.y, 370, 36, 10, 10) ||
            this.inArea(entity.x, entity.y, 312, 11, 25, 22) ||
            this.inArea(entity.x, entity.y, 399, 18, 20, 15)
        );
    }

    public isObject(object: number): boolean {
        return this.objects.includes(object);
    }

    /**
     * Uses the index (see `coordToIndex`) to obtain tile inforamtion in the tilemap.
     * @param index Gets tile information at an index in the map.
     * @returns Returns tile information (a number or number array)
     */

    public getTileData(index: number): ParsedTile {
        let data = this.data[index];

        if (!data) return [];

        let isArray = Array.isArray(data),
            parsedData: ParsedTile = isArray ? [] : 0;

        this.forEachTile(data, (tileId: number) => {
            let tile: ParsedTile = tileId;

            if (this.isFlipped(tileId)) tile = this.getFlippedTile(tileId);

            if (isArray) (parsedData as ParsedTile[]).push(tile);
            else parsedData = tile;
        });

        return parsedData;
    }

    /**
     * Grabs the rotated tile id from Tiled and performs bitwise operators
     * on it in order to convert it to an actual tileId. The bitshifts
     * indicate the type of rotation, and performing all the operations
     * results in the original tileId.
     * For more information refer to the following
     * https://doc.mapeditor.org/en/stable/reference/tmx-map-format/#tmx-tile-flipping
     * @param tileId The tileId of the flipped tile.
     * @returns A parsed tile of type `RotatedTile`.
     */

    public getFlippedTile(tileId: number): ParsedTile {
        let h = !!(tileId & Modules.Constants.HORIZONTAL_FLAG),
            v = !!(tileId & Modules.Constants.VERTICAL_FLAG),
            d = !!(tileId & Modules.Constants.DIAGONAL_FLAG);

        tileId &= ~(
            Modules.Constants.DIAGONAL_FLAG |
            Modules.Constants.VERTICAL_FLAG |
            Modules.Constants.HORIZONTAL_FLAG
        );

        return {
            tileId,
            h,
            v,
            d
        };
    }

    public getPositionObject(x: number, y: number): number {
        let index = this.coordToIndex(x, y),
            tiles = this.data[index],
            objectId!: number;

        if (Array.isArray(tiles)) {
            for (let i in tiles) if (this.isObject(tiles[i])) objectId = tiles[i];
        } else if (this.isObject(tiles)) objectId = tiles;

        return objectId;
    }

    public getCursor(tileIndex: number, tileId: number): string | undefined {
        if (tileId in this.cursors) return this.cursors[tileId];

        let cursor = Objects.getCursor(this.getObjectId(tileIndex));

        if (!cursor) return;

        return cursor;
    }

    private getObjectId(tileIndex: number): string {
        let position = this.indexToCoord(tileIndex + 1);

        return `${position.x}-${position.y}`;
    }

    // Transforms an object's `instance` or `id` into position
    public idToPosition(id: string): Pos {
        let split = id.split('-');

        return { x: parseInt(split[0]), y: parseInt(split[1]) };
    }

    public isDoor(x: number, y: number): boolean {
        return !!this.doors[this.coordToIndex(x, y)];
    }

    public getDoorByPosition(x: number, y: number): Door {
        return this.doors[this.coordToIndex(x, y)];
    }

    public isOutOfBounds(x: number, y: number): boolean {
        return x < 0 || x >= this.width || y < 0 || y >= this.height;
    }

    private isPlateau(index: number): boolean {
        return index in this.plateau;
    }

    public isCollisionIndex(index: number): boolean {
        return this.collisions.includes(index);
    }

    public isColliding(x: number, y: number): boolean {
        if (this.isOutOfBounds(x, y)) return false;

        return this.isCollisionIndex(this.coordToIndex(x, y));
    }

    /* For preventing NPCs from roaming in null areas. */
    public isEmpty(x: number, y: number): boolean {
        if (this.isOutOfBounds(x, y)) return true;

        let tileIndex = this.coordToIndex(x, y);

        return this.data[tileIndex] === 0;
    }

    public getPlateauLevel(x: number, y: number): number {
        let index = this.coordToIndex(x, y);

        if (!this.isPlateau(index)) return 0;

        return this.plateau[index];
    }

    public getWarpById(id: number): ProcessedArea | undefined {
        let warpName = Object.keys(Modules.Warps)[id];

        if (!warpName) return;

        let warp = this.getWarpByName(warpName.toLowerCase());

        if (!warp) return;

        warp.name = warpName;

        return warp;
    }

    private getWarpByName(name: string): ProcessedArea | undefined {
        for (let i in this.warps)
            if (this.warps[i].name === name) return _.cloneDeep(this.warps[i]);
    }

    public getChestAreas(): Areas {
        return this.areas.chests;
    }

    public getDynamicAreas(): Areas {
        return this.areas.dynamic;
    }

    public onReady(callback: () => void): void {
        this.readyCallback = callback;
    }

    public forEachAreas(callback: (areas: Areas, key: string) => void): void {
        _.each(this.areas, (a: Areas, name: string) => {
            callback(a, name);
        });
    }

    /**
     * Tile data consists of arrays and single numerical values.
     * This callback function is used to cleanly iterate through
     * those Tile[] arrays. i.e. [1, 2, [1, 2, 3], 4, [5, 6]]
     */

    public forEachTile(data: Tile, callback: (tileId: number, index?: number) => void): void {
        if (_.isArray(data)) _.each(data, callback);
        else callback(data as number);
    }

    /**
     * Parses through the entities in the raw map data and converts data for the controller.
     * @param callback The position of the entity and its string id.
     */

    public forEachEntity(callback: (position: Position, key: string) => void): void {
        _.each(this.entities, (key: string, tileId: string) => {
            let position = this.indexToCoord(parseInt(tileId));

            callback(position, key);
        });
    }
}
