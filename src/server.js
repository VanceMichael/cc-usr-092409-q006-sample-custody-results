import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
buildApp().listen(port, "0.0.0.0");
