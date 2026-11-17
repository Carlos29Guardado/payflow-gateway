import { crearApp } from "./app.js";
import { crearAgenteFraude } from "./fraud.js";

const PUERTO = process.env.PORT ?? 3000;

crearApp({ agenteFraude: crearAgenteFraude() }).listen(PUERTO, () => {
  const modo = process.env.ANTHROPIC_API_KEY ? "Claude" : "simulado (sin ANTHROPIC_API_KEY)";
  console.log(`PayFlow escuchando en http://localhost:${PUERTO} | antifraude: ${modo}`);
});
