import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearApp } from "../src/app.js";
import { reiniciarAlmacen } from "../src/store.js";

// Bancos de mentira para controlar qué pasa en cada prueba.
const bancoQueSiempreFunciona = async () => ({ autorizacion: "auth_ok" });
const bancoQueSiempreFalla = async () => {
  throw new Error("Banco caído");
};
// Falla las primeras "n" veces y luego funciona.
function bancoQueFallaNVeces(n) {
  let llamadas = 0;
  const banco = async () => {
    llamadas++;
    if (llamadas <= n) throw new Error("Banco intermitente");
    return { autorizacion: "auth_tras_reintento" };
  };
  banco.llamadas = () => llamadas;
  return banco;
}

let servidor;
let base;

// Arranca un servidor nuevo con el banco que le indiquemos. esperaBaseMs: 1
// para que los reintentos sean casi instantáneos en las pruebas.
async function iniciar(banco, opciones = {}) {
  servidor = crearApp({ banco, esperaBaseMs: 1, ...opciones });
  await new Promise((ok) => servidor.listen(0, ok)); // puerto 0 = uno libre al azar
  base = `http://localhost:${servidor.address().port}`;
}

beforeEach(() => reiniciarAlmacen());
afterEach(() => servidor?.close());

const enviar = (cuerpo, cabeceras = {}) =>
  fetch(`${base}/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cabeceras },
    body: JSON.stringify(cuerpo),
  });

const consultar = async (id) => (await fetch(`${base}/payments/${id}`)).json();

// ---------- Pieza 1: validación e idempotencia ----------

test("acepta un pago válido y responde 202 sin esperar al banco", async () => {
  await iniciar(bancoQueSiempreFunciona);
  const res = await enviar({ monto: 1050, moneda: "USD" });
  assert.equal(res.status, 202);
  const pago = await res.json();
  assert.match(pago.id, /^pay_/);
  assert.equal(pago.estado, "creado"); // todavía no pasó por el banco
  assert.equal(pago.monto, 1050);
});

test("rechaza montos inválidos", async () => {
  await iniciar(bancoQueSiempreFunciona);
  for (const monto of [0, -5, 10.5, "100"]) {
    const res = await enviar({ monto, moneda: "USD" });
    assert.equal(res.status, 422, `monto ${monto} debió rechazarse`);
  }
});

test("rechaza moneda inválida", async () => {
  await iniciar(bancoQueSiempreFunciona);
  const res = await enviar({ monto: 100, moneda: "dolares" });
  assert.equal(res.status, 422);
});

test("consulta un pago existente y da 404 si no existe", async () => {
  await iniciar(bancoQueSiempreFunciona);
  const creado = await (await enviar({ monto: 500, moneda: "USD" })).json();
  const ok = await fetch(`${base}/payments/${creado.id}`);
  assert.equal(ok.status, 200);
  const noExiste = await fetch(`${base}/payments/pay_inexistente`);
  assert.equal(noExiste.status, 404);
});

test("idempotencia: la misma clave NO crea un segundo pago ni lo cobra dos veces", async () => {
  const banco = bancoQueFallaNVeces(0);
  await iniciar(banco);
  const cabeceras = { "Idempotency-Key": "compra-123" };

  const primero = await (await enviar({ monto: 2000, moneda: "USD" }, cabeceras)).json();
  const res2 = await enviar({ monto: 2000, moneda: "USD" }, cabeceras);
  const segundo = await res2.json();
  await servidor.cola.esperarVacia();

  assert.equal(res2.status, 200);
  assert.equal(res2.headers.get("idempotent-replayed"), "true");
  assert.equal(segundo.id, primero.id);
  assert.equal(banco.llamadas(), 1, "el banco debió llamarse una sola vez");
});

test("sin clave de idempotencia, cada petición crea un pago distinto", async () => {
  await iniciar(bancoQueSiempreFunciona);
  const a = await (await enviar({ monto: 100, moneda: "USD" })).json();
  const b = await (await enviar({ monto: 100, moneda: "USD" })).json();
  assert.notEqual(a.id, b.id);
});

// ---------- Pieza 2: cola, reintentos y eventos ----------

test("la cola procesa el pago y pasa a 'capturado'", async () => {
  await iniciar(bancoQueSiempreFunciona);
  const creado = await (await enviar({ monto: 1000, moneda: "USD" })).json();
  await servidor.cola.esperarVacia();

  const pago = await consultar(creado.id);
  assert.equal(pago.estado, "capturado");
  assert.equal(pago.autorizacion, "auth_ok");
});

test("reintenta cuando el banco falla y al final lo logra", async () => {
  const banco = bancoQueFallaNVeces(2); // falla 2 veces, la 3ra funciona
  await iniciar(banco);
  const creado = await (await enviar({ monto: 1000, moneda: "USD" })).json();
  await servidor.cola.esperarVacia();

  const pago = await consultar(creado.id);
  assert.equal(pago.estado, "capturado");
  assert.equal(pago.intentos, 3);
  assert.equal(banco.llamadas(), 3);
});

test("si agota los intentos: estado 'fallido' y va a la cola de fallidos", async () => {
  await iniciar(bancoQueSiempreFalla, { maxIntentos: 3 });
  const creado = await (await enviar({ monto: 1000, moneda: "USD" })).json();
  await servidor.cola.esperarVacia();

  const pago = await consultar(creado.id);
  assert.equal(pago.estado, "fallido");
  assert.equal(pago.error, "Banco caído");
  assert.equal(servidor.cola.fallidos.length, 1);
});

test("emite los eventos pago.capturado y pago.fallido", async () => {
  await iniciar(bancoQueSiempreFunciona);
  const recibidos = [];
  servidor.eventos.on("pago.capturado", (p) => recibidos.push(["capturado", p.id]));
  const bueno = await (await enviar({ monto: 100, moneda: "USD" })).json();
  await servidor.cola.esperarVacia();
  assert.deepEqual(recibidos, [["capturado", bueno.id]]);
  servidor.close();

  await iniciar(bancoQueSiempreFalla);
  const fallidos = [];
  servidor.eventos.on("pago.fallido", (p) => fallidos.push(p.id));
  const malo = await (await enviar({ monto: 100, moneda: "USD" })).json();
  await servidor.cola.esperarVacia();
  assert.deepEqual(fallidos, [malo.id]);
});

test("la cola atiende en orden de llegada (FIFO)", async () => {
  await iniciar(bancoQueSiempreFunciona);
  const orden = [];
  servidor.eventos.on("pago.capturado", (p) => orden.push(p.monto));
  for (const monto of [100, 200, 300]) await enviar({ monto, moneda: "USD" });
  await servidor.cola.esperarVacia();
  assert.deepEqual(orden, [100, 200, 300]);
});
