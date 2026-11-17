// Sirve el frontend (la carpeta /public) para que la misma app muestre la pantalla.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CARPETA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

// Devuelve true si respondió con un archivo; false si no existe (la API sigue con su 404).
export async function servirEstatico(pathname, res) {
  const pedido = pathname === "/" ? "/index.html" : pathname;
  const archivo = path.normalize(path.join(CARPETA, pedido));

  // Evita salirse de /public con rutas como /../src/store.js
  if (!archivo.startsWith(CARPETA + path.sep)) return false;

  const tipo = TIPOS[path.extname(archivo)];
  if (!tipo) return false;

  try {
    const contenido = await readFile(archivo);
    res.writeHead(200, { "Content-Type": tipo });
    res.end(contenido);
    return true;
  } catch {
    return false;
  }
}
