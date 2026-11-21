import { openDB } from "idb";
import type { Metrics, Word } from "./analyze";
export interface Session {
  id: string; title: string; createdAt: number; audio: Blob;
  text: string; words: Word[]; metrics: Metrics;
}
const dbp = openDB("speech-coach", 1, { upgrade(db) { db.createObjectStore("sessions", { keyPath: "id" }); } });
export const saveSession = async (s: Session) => (await dbp).put("sessions", s);
export const deleteSession = async (id: string) => (await dbp).delete("sessions", id);
export const deleteAllSessions = async () => (await dbp).clear("sessions");
export const listSessions = async (): Promise<Session[]> =>
  ((await (await dbp).getAll("sessions")) as Session[]).sort((a, b) => b.createdAt - a.createdAt);
