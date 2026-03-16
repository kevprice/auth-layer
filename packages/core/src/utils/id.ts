import { randomUUID } from "node:crypto";

export const createId = (): string => randomUUID();
