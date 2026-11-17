import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { crearApp } from "../src/app.js";

let payflow;
afterEach(() => payflow?.close());

async function iniciar() {
  payflow = crearApp();
  await new Promise((ok) => payflow.listen(0, ok));
  return payflow.address().port;
}

test("la raíz sirve el frontend y los archivos tienen su tipo correcto", async () => {
  const puerto = await iniciar();
  const base = `http://localhost:${puerto}`;

  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type"), /text\/html/);
  assert.match(await html.text(), /PayFlow/);

  const js = await fetch(`${base}/app.js`);
  assert.match(js.headers.get("content-type"), /javascript/);
});

test("no se puede salir de /public con rutas como /../src/store.js", async () => {
  const puerto = await iniciar();

  // fetch normaliza los ".." antes de enviar, así que mandamos la petición a mano.
  const respuesta = await new Promise((resolve) => {
    const socket = net.connect(puerto, "localhost", () => {
      socket.write("GET /../src/store.js HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    });
    let datos = "";
    socket.on("data", (t) => (datos += t));
    socket.on("end", () => resolve(datos));
  });

  assert.match(respuesta, /^HTTP\/1\.1 404/);
  assert.doesNotMatch(respuesta, /crearPago/);
});
