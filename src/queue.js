// La cola de trabajos: la "fila de la panadería".
//
// Idea: en vez de procesar el pago mientras el cliente espera, anotamos
// un "trabajo" en la fila y respondemos enseguida. Un trabajador (worker)
// va atendiendo la fila de uno en uno, en orden.
//
// Si un trabajo falla, se reintenta esperando cada vez más (backoff exponencial):
//   intento 1 falla -> espera 1x, intento 2 falla -> espera 2x, intento 3 falla -> ...
// Si agota todos los intentos, va a la "cola de fallidos" (dead-letter queue)
// para que una persona (o un agente) la revise. Nunca se pierde en silencio.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export class Cola extends EventEmitter {
  pendientes = []; // trabajos esperando turno
  fallidos = []; // dead-letter queue: trabajos que se rindieron

  #procesando = false; // ¿hay un trabajador atendiendo ahora mismo?
  #reintentosEnEspera = 0; // trabajos dormidos esperando su próximo intento

  constructor({ procesador, maxIntentos = 3, esperaBaseMs = 200 }) {
    super();
    this.procesador = procesador; // función que hace el trabajo real
    this.maxIntentos = maxIntentos;
    this.esperaBaseMs = esperaBaseMs;
  }

  // Anota un trabajo en la fila y responde de inmediato.
  encolar(datos) {
    const trabajo = { id: `job_${randomUUID()}`, datos, intentos: 0, ultimoError: null };
    this.pendientes.push(trabajo);
    this.#despertar();
    return trabajo.id;
  }

  // Resuelve cuando la fila está vacía y no queda nada por reintentar.
  // Útil sobre todo en las pruebas.
  esperarVacia() {
    if (this.#estaVacia()) return Promise.resolve();
    return new Promise((ok) => this.once("vacia", ok));
  }

  #estaVacia() {
    return !this.#procesando && this.pendientes.length === 0 && this.#reintentosEnEspera === 0;
  }

  #despertar() {
    if (this.#procesando) return; // ya hay un trabajador atendiendo
    this.#procesando = true;
    setImmediate(() => this.#atender());
  }

  // Avisa a quien escuche, pero un oyente que falla NUNCA debe afectar a la cola:
  // ni reintentar un trabajo que ya salió bien, ni dejar al trabajador atascado.
  #avisar(evento, trabajo) {
    try {
      this.emit(evento, trabajo);
    } catch {
      // el error del oyente es problema del oyente
    }
  }

  async #atender() {
    try {
      while (this.pendientes.length > 0) {
        const trabajo = this.pendientes.shift();
        let fallo = null;

        // El try cubre SOLO el trabajo real. Así, solo un fallo del procesador cuenta como fallo.
        try {
          await this.procesador(trabajo.datos, trabajo);
        } catch (error) {
          fallo = error ?? new Error("falló sin detalle"); // throw null / throw "texto"
        }

        if (!fallo) {
          this.#avisar("trabajo.completado", trabajo);
          continue;
        }

        trabajo.intentos++;
        trabajo.ultimoError = fallo.message ?? String(fallo);

        if (trabajo.intentos >= this.maxIntentos) {
          this.fallidos.push(trabajo); // me rindo: a la cola de fallidos
          this.#avisar("trabajo.fallido", trabajo);
        } else {
          // Espero 1x, 2x, 4x... antes de volver a intentarlo.
          const espera = this.esperaBaseMs * 2 ** (trabajo.intentos - 1);
          this.#reintentosEnEspera++;
          setTimeout(() => {
            this.#reintentosEnEspera--;
            this.pendientes.push(trabajo);
            this.#despertar();
          }, espera);
        }
      }
    } finally {
      // Pase lo que pase, el trabajador se libera: la fila nunca queda bloqueada.
      this.#procesando = false;
      if (this.#estaVacia()) this.#avisar("vacia");
    }
  }
}
