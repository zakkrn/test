import { randomUUID } from "node:crypto";
import { createClient } from "redis";

export type Release = () => Promise<void>;

/** The two Redis commands the lock uses. */
interface LockClient {
  set(key: string, value: string, options: { condition: "NX"; expiration: { type: "PX"; value: number } }): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

/** Gives one turn at a time exclusive access to a conversation. */
export interface ConversationLock {
  acquire(key: string): Promise<Release>;
}

/** Serializes turns within this process. Enough when running a single instance. */
export class InProcessLock implements ConversationLock {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<Release> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    return async () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}

const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const RENEW_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

/**
 * Distributed lock in Redis, so several instances of the agent can run side by side.
 * The lock expires after `ttlMs` if its holder dies, and is renewed while the turn runs.
 */
export class RedisLock implements ConversationLock {
  private readonly local = new InProcessLock();

  constructor(
    private readonly redis: LockClient,
    private readonly ttlMs = 60_000,
    private readonly waitMs = 15 * 60_000,
  ) {}

  static async connect(url: string): Promise<RedisLock> {
    const client = createClient({ url });
    client.on("error", (error) => console.error("Redis error:", error));
    await client.connect();
    return new RedisLock(client as unknown as LockClient);
  }

  async acquire(key: string): Promise<Release> {
    // Queue locally first, so only one turn per conversation polls Redis from this process.
    const releaseLocal = await this.local.acquire(key);
    const redisKey = `lock:${key}`;
    const token = randomUUID();
    const deadline = Date.now() + this.waitMs;

    try {
      let delay = 50;
      while ((await this.redis.set(redisKey, token, { condition: "NX", expiration: { type: "PX", value: this.ttlMs } })) !== "OK") {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for conversation lock ${key}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 1000);
      }
    } catch (error) {
      await releaseLocal();
      throw error;
    }

    const renewal = setInterval(() => {
      this.redis
        .eval(RENEW_SCRIPT, { keys: [redisKey], arguments: [token, String(this.ttlMs)] })
        .catch((error) => console.error("Could not renew conversation lock:", error));
    }, this.ttlMs / 3);

    return async () => {
      clearInterval(renewal);
      try {
        await this.redis.eval(RELEASE_SCRIPT, { keys: [redisKey], arguments: [token] });
      } finally {
        await releaseLocal();
      }
    };
  }
}
