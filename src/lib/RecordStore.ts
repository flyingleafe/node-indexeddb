import FDBKeyRange from "../FDBKeyRange.js";
import {
    getByKey,
    getByKeyRange,
    getIndexByKey,
    getIndexByKeyGTE,
    getIndexByKeyRange,
} from "./binarySearch.js";
import cmp from "./cmp.js";
import { Key, Record } from "./types.js";
import dbManager from "./LevelDBManager.js";

export type RecordStoreType = "object" | "index";
export const SEPARATOR = "_";

class RecordStore {
    private records: Record[] = [];
    private keyPrefix: string;
    private type: RecordStoreType;
    constructor(keyPrefix: string, type: RecordStoreType) {
        this.keyPrefix = keyPrefix;
        this.type = type;

        this.loadRecordsFromCache();
    }

    private loadRecordsFromCache() {
        if (!dbManager.isLoaded) {
            throw new Error(
                "Database not loaded yet. Ensure dbManager.loadCache() is called before creating RecordStore instances.",
            );
        }
        const cachedRecords = dbManager.getValuesForKeysStartingWith(
            this.keyPrefix,
            this.type,
        );
        this.records = cachedRecords.sort((a, b) => cmp(a.key, b.key));

        // Optionally, remove these records from dbManager's cache to save memory
        // cachedRecords.forEach(record => {
        //     dbManager.delete(this.keyPrefix + record.key.toString());
        // });
    }

    public get(key: Key | FDBKeyRange) {
        if (key instanceof FDBKeyRange) {
            return getByKeyRange(this.records, key);
        }
        return getByKey(this.records, key);
    }

    public add(newRecord: Record) {
        let i = getIndexByKeyGTE(this.records, newRecord.key);
        if (i === -1) {
            i = this.records.length;
        } else {
            while (
                i < this.records.length &&
                cmp(this.records[i].key, newRecord.key) === 0
            ) {
                if (cmp(this.records[i].value, newRecord.value) !== -1) {
                    break;
                }
                i += 1;
            }
        }

        this.records.splice(i, 0, newRecord);

        // Write-through to dbManager
        dbManager.set(
            this.type + SEPARATOR + this.keyPrefix + newRecord.key.toString(),
            newRecord,
        );
    }

    public delete(key: Key) {
        const deletedRecords: Record[] = [];
        const isRange = key instanceof FDBKeyRange;
        while (true) {
            const idx = isRange
                ? getIndexByKeyRange(this.records, key)
                : getIndexByKey(this.records, key);
            if (idx === -1) {
                break;
            }
            const deletedRecord = this.records[idx];
            deletedRecords.push(deletedRecord);
            this.records.splice(idx, 1);

            // Write-through to dbManager
            dbManager.delete(this.keyPrefix + deletedRecord.key.toString());
        }
        return deletedRecords;
    }

    public deleteByValue(key: Key) {
        const range = key instanceof FDBKeyRange ? key : FDBKeyRange.only(key);
        const deletedRecords: Record[] = [];
        this.records = this.records.filter((record) => {
            const shouldDelete = range.includes(record.value);
            if (shouldDelete) {
                deletedRecords.push(record);
                // Write-through to dbManager
                dbManager.delete(this.keyPrefix + record.key.toString());
            }
            return !shouldDelete;
        });
        return deletedRecords;
    }

    public clear() {
        const deletedRecords = this.records.slice();
        this.records = [];

        // Write-through to dbManager
        for (const record of deletedRecords) {
            dbManager.delete(this.keyPrefix + record.key.toString());
        }

        return deletedRecords;
    }
    public values(range?: FDBKeyRange, direction: "next" | "prev" = "next") {
        return {
            [Symbol.iterator]: () => {
                let i: number;
                if (direction === "next") {
                    i = 0;
                    if (range !== undefined && range.lower !== undefined) {
                        while (this.records[i] !== undefined) {
                            const cmpResult = cmp(
                                this.records[i].key,
                                range.lower,
                            );
                            if (
                                cmpResult === 1 ||
                                (cmpResult === 0 && !range.lowerOpen)
                            ) {
                                break;
                            }
                            i += 1;
                        }
                    }
                } else {
                    i = this.records.length - 1;
                    if (range !== undefined && range.upper !== undefined) {
                        while (this.records[i] !== undefined) {
                            const cmpResult = cmp(
                                this.records[i].key,
                                range.upper,
                            );
                            if (
                                cmpResult === -1 ||
                                (cmpResult === 0 && !range.upperOpen)
                            ) {
                                break;
                            }
                            i -= 1;
                        }
                    }
                }

                return {
                    next: () => {
                        let done;
                        let value;
                        if (direction === "next") {
                            value = this.records[i];
                            done = i >= this.records.length;
                            i += 1;

                            if (
                                !done &&
                                range !== undefined &&
                                range.upper !== undefined
                            ) {
                                const cmpResult = cmp(value.key, range.upper);
                                done =
                                    cmpResult === 1 ||
                                    (cmpResult === 0 && range.upperOpen);
                                if (done) {
                                    value = undefined;
                                }
                            }
                        } else {
                            value = this.records[i];
                            done = i < 0;
                            i -= 1;

                            if (
                                !done &&
                                range !== undefined &&
                                range.lower !== undefined
                            ) {
                                const cmpResult = cmp(value.key, range.lower);
                                done =
                                    cmpResult === -1 ||
                                    (cmpResult === 0 && range.lowerOpen);
                                if (done) {
                                    value = undefined;
                                }
                            }
                        }

                        // The weird "as IteratorResult<Record>" is needed because of
                        // https://github.com/Microsoft/TypeScript/issues/11375 and
                        // https://github.com/Microsoft/TypeScript/issues/2983
                        return {
                            done,
                            value,
                        } as IteratorResult<Record>;
                    },
                };
            },
        };
    }
}

export default RecordStore;
