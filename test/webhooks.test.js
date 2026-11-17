import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { crearApp } from "../src/app.js";
import { reiniciarAlmacen } from "../src/store.js";
import { firmar, verificar } from "../src/signature.js";

const bancoBueno = async () => ({ autorizacion: "auth_ok" });
const bancoMalo = async () => {
  throw new Error("Banco caído");
};

let payflow, base;
let tienda; // la "tienda" de mentira que recibe los avisos

beforeEach(() => reiniciarAlmacen());
afterEach(() => {
  payflow?.close();
  tienda?.server.close();
});

async function iniciar(banco) {
  payflow = crearApp({ banco, esperaBaseMs: 1 });
  await new Promise((ok) => payflow.listen(0, ok));
  base = `http://localhost:${payflow.address().port}`;
}

// Una tienda de mentira: guarda todo lo que recibe y contesta con los códigos que le demos.
// Ejemplo: [500, 500, 200] = falla dos veces y luego funciona.
async function iniciarTienda(codigos = [200]) {
  const recibidos = [];
  const server = http.createServer((req, res) => {
    let cuerpo = "";
    req.on("data", (t) => (cuerpo += t));
    req.on("end", () => {
      recibidos.push({ cuerpo, firma: req.headers["payflow-signature"] });
      const codigo = codigos[Math.min(recibidos.length - 1, codigos.length - 1)];
      res.writeHead(codigo).end();
    });
  });
  await new Promise((ok) => server.listen(0, ok));
  tienda = { server, recibidos, url: `http://localhost:${server.address().port}/aviso` };
  return tienda;
}

const post = (ruta, cuerpo) =>
  fetch(`${base}${ruta}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });

// Espera a que termine todo: primero el pago, luego los avisos.
async function esperarTodo() {
  await payflow.cola.esperarVacia();
  await payflow.colaWebhooks.esperarVacia();
}

test("registrar un webhook devuelve un secreto; rechaza direcciones inválidas", async () => {
  await iniciar(bancoBueno);
  const ok = await post("/webhooks", { url: "https://mitienda.com/aviso" });
  assert.equal(ok.status, 201);
  const wh = await ok.json();
  assert.match(wh.id, /^wh_/);
  assert.match(wh.secreto, /^whsec_/);

  for (const url of ["hola", "ftp://x.com", undefined]) {
    const mal = await post("/webhooks", { url });
    assert.equal(mal.status, 422, `${url} debió rechazarse`);
  }
});

test("cuando el pago se captura, la tienda recibe un aviso con firma válida", async () => {
  await iniciar(bancoBueno);
  const t = await iniciarTienda();
  const wh = await (await post("/webhooks", { url: t.url })).json();

  const pago = await (await post("/payments", { monto: 1500, moneda: "USD" })).json();
  await esperarTodo();

  assert.equal(t.recibidos.length, 1);
  const { cuerpo, firma } = t.recibidos[0];
  const evento = JSON.parse(cuerpo);
  assert.equal(evento.tipo, "pago.capturado");
  assert.equal(evento.datos.id, pago.id);
  assert.equal(evento.datos.estado, "capturado");
  // Lo que haría la tienda: comprobar la firma con su secreto.
  assert.equal(verificar(wh.secreto, cuerpo, firma), true);
});

test("un pago fallido también avisa a la tienda", async () => {
  await iniciar(bancoMalo);
  const t = await iniciarTienda();
  await post("/webhooks", { url: t.url });

  await post("/payments", { monto: 1500, moneda: "USD" });
  await esperarTodo();

  assert.equal(t.recibidos.length, 1);
  assert.equal(JSON.parse(t.recibidos[0].cuerpo).tipo, "pago.fallido");
});

test("una firma falsa o un mensaje alterado NO pasan la verificación", () => {
  const secreto = "whsec_secreto_real";
  const cuerpo = '{"monto":100}';
  const firma = firmar(secreto, cuerpo);

  assert.equal(verificar(secreto, cuerpo, firma), true);
  assert.equal(verificar("whsec_otro_secreto", cuerpo, firma), false, "secreto equivocado");
  assert.equal(verificar(secreto, '{"monto":999999}', firma), false, "cuerpo alterado");

  const vieja = firmar(secreto, cuerpo, Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verificar(secreto, cuerpo, vieja), false, "mensaje de hace una hora");
});

test("si la tienda falla, PayFlow reintenta y manda siempre el mismo evento", async () => {
  await iniciar(bancoBueno);
  const t = await iniciarTienda([500, 500, 200]); // falla 2 veces, luego funciona
  await post("/webhooks", { url: t.url });

  await post("/payments", { monto: 1500, moneda: "USD" });
  await esperarTodo();

  assert.equal(t.recibidos.length, 3);
  const ids = t.recibidos.map((r) => JSON.parse(r.cuerpo).id);
  assert.equal(new Set(ids).size, 1, "los 3 intentos llevan el mismo id de evento");
  assert.equal(payflow.colaWebhooks.fallidos.length, 0);
});

test("si la tienda nunca responde bien, el aviso va a fallidos y el pago NO se afecta", async () => {
  await iniciar(bancoBueno);
  const t = await iniciarTienda([500]); // siempre 500
  await post("/webhooks", { url: t.url });

  const pago = await (await post("/payments", { monto: 1500, moneda: "USD" })).json();
  await esperarTodo();

  assert.equal(t.recibidos.length, 3); // 3 intentos y se rinde
  assert.equal(payflow.colaWebhooks.fallidos.length, 1);
  const actual = await (await fetch(`${base}/payments/${pago.id}`)).json();
  assert.equal(actual.estado, "capturado", "el cobro sigue bien aunque el aviso falló");
});
