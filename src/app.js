// La API: recibe peticiones HTTP y responde en JSON.

import http from "node:http";
import { EventEmitter } from "node:events";
import {
  crearPago,
  obtenerPago,
  actualizarPago,
  pagoPorClave,
  guardarClave,
  registrarWebhook,
} from "./store.js";
import { Cola } from "./queue.js";
import { crearWebhooks } from "./webhooks.js";
import { bancoSimulado } from "./bank.js";
import { crearProcesadorPagos } from "./processor.js";
import { servirEstatico } from "./static.js";

function responder(res, codigo, cuerpo, cabeceras = {}) {
  res.writeHead(codigo, { "Content-Type": "application/json", ...cabeceras });
  res.end(JSON.stringify(cuerpo));
}

// Lee el cuerpo (body) de la petición y lo convierte de texto a objeto.
function leerJson(req) {
  return new Promise((resolve, reject) => {
    let texto = "";
    req.on("data", (trozo) => (texto += trozo));
    req.on("end", () => {
      try {
        resolve(texto ? JSON.parse(texto) : {});
      } catch {
        reject(new Error("JSON inválido"));
      }
    });
  });
}

// Revisa que los datos del pago tengan sentido. Devuelve un mensaje de error o null.
function validarPago({ monto, moneda }) {
  if (!Number.isInteger(monto) || monto <= 0) {
    return "monto debe ser un número entero positivo (en centavos)";
  }
  if (typeof moneda !== "string" || !/^[A-Z]{3}$/.test(moneda)) {
    return "moneda debe ser un código de 3 letras mayúsculas, por ejemplo USD";
  }
  return null;
}

// Comprueba que sea una dirección web con http o https.
function urlValida(texto) {
  try {
    const url = new URL(texto);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// "banco" y "esperaBaseMs" se pueden cambiar desde afuera; así las pruebas
// controlan cuándo falla el banco y no tienen que esperar de verdad.
// "agenteFraude" es opcional (por defecto no hay): así las pruebas no llaman a ninguna IA.
// server.js es quien lo activa.
export function crearApp({
  banco = bancoSimulado(),
  agenteFraude = null,
  esperaBaseMs = 200,
  maxIntentos = 3,
} = {}) {
  const eventos = new EventEmitter(); // el megáfono de eventos del sistema
  const cola = new Cola({
    procesador: crearProcesadorPagos({ banco, eventos, agenteFraude }),
    maxIntentos,
    esperaBaseMs,
  });

  // Los webhooks escuchan los eventos y avisan a las tiendas registradas.
  const colaWebhooks = crearWebhooks({ eventos, maxIntentos, esperaBaseMs });

  // Si la cola se rinde con un pago, lo marcamos como fallido y avisamos.
  cola.on("trabajo.fallido", (trabajo) => {
    const { idPago } = trabajo.datos;
    actualizarPago(idPago, { estado: "fallido", error: trabajo.ultimoError });
    eventos.emit("pago.fallido", obtenerPago(idPago));
  });

  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    // POST /payments -> crear un pago
    if (req.method === "POST" && url.pathname === "/payments") {
      let datos;
      try {
        datos = await leerJson(req);
      } catch {
        return responder(res, 400, { error: "El cuerpo no es un JSON válido" });
      }

      const error = validarPago(datos);
      if (error) return responder(res, 422, { error });

      // Idempotencia: si el cliente reintenta con la misma clave,
      // devolvemos el pago original en vez de crear (y cobrar) otro.
      const clave = req.headers["idempotency-key"];
      if (clave) {
        const existente = pagoPorClave(clave);
        if (existente) {
          return responder(res, 200, existente, { "Idempotent-Replayed": "true" });
        }
      }

      const pago = crearPago(datos);
      if (clave) guardarClave(clave, pago.id);

      // Lo anotamos en la fila y respondemos YA. El banco se llama después.
      cola.encolar({ idPago: pago.id });

      // 202 = "Aceptado": recibí tu pago, lo estoy procesando.
      return responder(res, 202, pago);
    }

    // POST /webhooks -> una tienda registra dónde quiere recibir los avisos
    if (req.method === "POST" && url.pathname === "/webhooks") {
      let datos;
      try {
        datos = await leerJson(req);
      } catch {
        return responder(res, 400, { error: "El cuerpo no es un JSON válido" });
      }
      if (!urlValida(datos.url)) {
        return responder(res, 422, { error: "url debe ser una dirección http:// o https:// válida" });
      }
      // Devolvemos el secreto una sola vez: la tienda debe guardarlo.
      return responder(res, 201, registrarWebhook({ url: datos.url }));
    }

    // GET /payments/:id -> consultar un pago
    const coincidencia = url.pathname.match(/^\/payments\/([\w-]+)$/);
    if (req.method === "GET" && coincidencia) {
      const pago = obtenerPago(coincidencia[1]);
      if (!pago) return responder(res, 404, { error: "Pago no encontrado" });
      return responder(res, 200, pago);
    }

    // Cualquier otro GET: probamos si es un archivo del frontend.
    if (req.method === "GET" && (await servirEstatico(url.pathname, res))) return;

    return responder(res, 404, { error: "Ruta no encontrada" });
  });

  // Dejamos a mano la cola y los eventos para las pruebas y para la pieza 3.
  servidor.cola = cola;
  servidor.colaWebhooks = colaWebhooks;
  servidor.eventos = eventos;
  return servidor;
}
