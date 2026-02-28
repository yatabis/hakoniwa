import type { WaterSource, WorldState } from '../core/types';

const DB_NAME = 'hakoniwa-worlds';
const DB_VERSION = 1;
const STORE_NAME = 'slots';

interface SerializedWorld {
  version: number;
  size: number;
  terrainSeed?: number;
  terrain: number[];
  water: number[];
  sources: WaterSource[];
  vegetationSeed: number;
  time: number;
}

interface SlotRecord {
  slot: number;
  data: ArrayBuffer;
  updatedAt: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateSources(value: unknown): WaterSource[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid source payload');
  }

  return value.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as WaterSource).id !== 'string' ||
      !isFiniteNumber((item as WaterSource).x) ||
      !isFiniteNumber((item as WaterSource).y) ||
      !isFiniteNumber((item as WaterSource).rate) ||
      typeof (item as WaterSource).active !== 'boolean'
    ) {
      throw new Error('Invalid source entry');
    }

    return {
      id: (item as WaterSource).id,
      x: (item as WaterSource).x,
      y: (item as WaterSource).y,
      rate: (item as WaterSource).rate,
      active: (item as WaterSource).active
    };
  });
}

export async function serializeWorld(state: WorldState): Promise<ArrayBuffer> {
  const payload: SerializedWorld = {
    version: state.version,
    size: state.size,
    terrainSeed: state.terrainSeed,
    terrain: Array.from(state.terrain),
    water: Array.from(state.water),
    sources: state.sources,
    vegetationSeed: state.vegetationSeed,
    time: state.time
  };

  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  return encoded.buffer;
}

export async function deserializeWorld(data: ArrayBuffer): Promise<WorldState> {
  const text = new TextDecoder().decode(new Uint8Array(data));
  const parsed: unknown = JSON.parse(text);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid world payload');
  }

  const world = parsed as Partial<SerializedWorld>;
  if (
    !isFiniteNumber(world.version) ||
    !isFiniteNumber(world.size) ||
    !Array.isArray(world.terrain) ||
    !Array.isArray(world.water) ||
    !isFiniteNumber(world.vegetationSeed) ||
    !isFiniteNumber(world.time)
  ) {
    throw new Error('Incomplete world payload');
  }

  const size = world.size;
  const expectedLength = size * size;
  if (world.terrain.length !== expectedLength || world.water.length !== expectedLength) {
    throw new Error('Corrupted world dimensions');
  }

  return {
    version: 1,
    size,
    terrainSeed: isFiniteNumber(world.terrainSeed) ? world.terrainSeed : 0,
    terrain: Float32Array.from(world.terrain),
    water: Float32Array.from(world.water),
    sources: validateSources(world.sources),
    vegetationSeed: world.vegetationSeed,
    time: world.time
  };
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available in this environment');
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener('upgradeneeded', () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'slot' });
      }
    });

    request.addEventListener('success', () => {
      resolve(request.result);
    });

    request.addEventListener('error', () => {
      reject(request.error ?? new Error('Failed to open IndexedDB'));
    });
  });
}

export async function saveWorldToSlot(slot: number, state: WorldState): Promise<void> {
  const db = await openDb();
  const payload = await serializeWorld(state);

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record: SlotRecord = {
      slot,
      data: payload,
      updatedAt: Date.now()
    };

    store.put(record);

    tx.addEventListener('complete', () => {
      resolve();
    });

    tx.addEventListener('error', () => {
      reject(tx.error ?? new Error('Failed to save slot'));
    });

    tx.addEventListener('abort', () => {
      reject(tx.error ?? new Error('Save transaction aborted'));
    });
  });

  db.close();
}

export async function loadWorldFromSlot(slot: number): Promise<WorldState | null> {
  const db = await openDb();

  const record = await new Promise<SlotRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(slot);

    request.addEventListener('success', () => {
      resolve((request.result as SlotRecord | undefined) ?? null);
    });

    request.addEventListener('error', () => {
      reject(request.error ?? new Error('Failed to load slot'));
    });
  });

  db.close();

  if (!record) {
    return null;
  }

  return deserializeWorld(record.data);
}
