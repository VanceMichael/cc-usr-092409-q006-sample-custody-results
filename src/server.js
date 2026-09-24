import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const journalFile = process.env.JOURNAL_FILE ?? "data/chain.journal.jsonl";
buildApp({ journalFile }).listen(port, "0.0.0.0");
