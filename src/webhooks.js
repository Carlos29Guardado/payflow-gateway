// Los webhooks: PayFlow le "toca el timbre" a la tienda cuando algo pasa.
//
// Sin webhooks, la tienda tendría que preguntar una y otra vez "¿ya se pagó?".
// Con webhooks, PayFlow le avisa solita en cuanto el pago se captura o falla.

import { randomUUID } from "node:crypto";
import { Cola } from "./queue.js";
import { firmar } from "./signature.js";
import { listarWebhooks } from "./store.js";

export function crearWebhooks({ eventos, maxIntentos, esperaBaseMs }) {
  // Una entrega de aviso es un trabajo más. Reutilizamos la misma Cola de la pieza 2:
  // si la tienda no contesta, se reintenta con espera creciente, y si no hay manera,
  // el aviso queda en la lista de fallidos para revisarlo.
  const cola = new Cola({ procesador: entregar, maxIntentos, esperaBaseMs });

  async function entregar({ webhook, evento }) {
    const cuerpo = JSON.stringify(evento);
    const respuesta = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PayFlow-Signature": firmar(webhook.secreto, cuerpo),
      },
      body: cuerpo,
      signal: AbortSignal.timeout(5000), // si la tienda no responde en 5 s, cuenta como fallo
    });
    // Cualquier respuesta que no sea 2xx (200, 201...) cuenta como "no recibido".
    if (!respuesta.ok) throw new Error(`La tienda respondió ${respuesta.status}`);
  }

  // Escuchamos el "megáfono" de eventos de la pieza 2.
  for (const tipo of ["pago.capturado", "pago.fallido", "pago.rechazado", "pago.en_revision"]) {
    eventos.on(tipo, (pago) => {
      // Un solo id por evento: si hay reintentos, la tienda recibe SIEMPRE el mismo id
      // y puede darse cuenta de que es un duplicado.
      const evento = {
        id: `evt_${randomUUID()}`,
        tipo,
        creadoEn: new Date().toISOString(),
        datos: pago,
      };
      for (const webhook of listarWebhooks()) {
        cola.encolar({ webhook, evento });
      }
    });
  }

  return cola;
}
