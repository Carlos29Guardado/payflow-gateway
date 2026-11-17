import { test } from "node:test";
import assert from "node:assert/strict";
import { Cola } from "../src/queue.js";

test("un oyente que lanza error NO provoca que un trabajo exitoso se reintente", async () => {
  let ejecuciones = 0;
  const cola = new Cola({
    procesador: async () => {
      ejecuciones++;
    },
    esperaBaseMs: 1,
  });
  cola.on("trabajo.completado", () => {
    throw new Error("oyente roto");
  });

  cola.encolar({ monto: 100 });
  await cola.esperarVacia();

  assert.equal(ejecuciones, 1, "el pago se procesó una sola vez");
  assert.equal(cola.fallidos.length, 0);
});

test("un oyente roto en 'trabajo.fallido' no deja la cola atascada", async () => {
  const cola = new Cola({
    procesador: async () => {
      throw new Error("banco caído");
    },
    maxIntentos: 1,
    esperaBaseMs: 1,
  });
  cola.on("trabajo.fallido", () => {
    throw new Error("oyente roto");
  });

  cola.encolar({});
  await cola.esperarVacia(); // si la cola se atascara, esto no resolvería nunca

  cola.encolar({});
  await cola.esperarVacia();
  assert.equal(cola.fallidos.length, 2, "la cola siguió funcionando");
});

test("si el procesador lanza algo que no es un Error, el trabajo va a fallidos sin romper la cola", async () => {
  const cola = new Cola({
    procesador: async () => {
      throw null;
    },
    maxIntentos: 2,
    esperaBaseMs: 1,
  });

  cola.encolar({});
  await cola.esperarVacia();

  assert.equal(cola.fallidos.length, 1);
  assert.equal(cola.fallidos[0].intentos, 2);
  assert.equal(typeof cola.fallidos[0].ultimoError, "string");
});
