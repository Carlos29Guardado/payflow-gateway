// "Almacén" de datos en memoria.
// Por ahora guardamos todo en variables. Más adelante lo cambiaremos por PostgreSQL.
// Si reinicias el servidor, los datos se pierden (es normal en esta etapa).

import { randomUUID, randomBytes } from "node:crypto";

const webhooks = new Map(); // id del webhook -> webhook
const pagos = new Map(); // id del pago -> pago
const clavesIdempotencia = new Map(); // clave -> id del pago que ya se creó

export function crearPago({ monto, moneda, descripcion }) {
  const pago = {
    id: `pay_${randomUUID()}`,
    monto, // en centavos: $10.50 se guarda como 1050 (evita errores con decimales)
    moneda,
    descripcion: descripcion ?? null,
    estado: "creado", // creado -> procesando -> capturado | fallido
    intentos: 0,
    creadoEn: new Date().toISOString(),
  };
  pagos.set(pago.id, pago);
  return pago;
}

export function obtenerPago(id) {
  return pagos.get(id) ?? null;
}

// Cambia campos de un pago ya guardado (por ejemplo, su estado).
export function actualizarPago(id, cambios) {
  const pago = pagos.get(id);
  if (!pago) return null;
  Object.assign(pago, cambios);
  return pago;
}

export function pagoPorClave(clave) {
  const id = clavesIdempotencia.get(clave);
  return id ? pagos.get(id) : null;
}

export function guardarClave(clave, idPago) {
  clavesIdempotencia.set(clave, idPago);
}

// Una tienda registra la dirección (URL) donde quiere recibir los avisos.
// Le damos un secreto para que pueda comprobar que los avisos vienen de PayFlow.
export function registrarWebhook({ url }) {
  const webhook = {
    id: `wh_${randomUUID()}`,
    url,
    secreto: `whsec_${randomBytes(16).toString("hex")}`,
  };
  webhooks.set(webhook.id, webhook);
  return webhook;
}

export function listarWebhooks() {
  return [...webhooks.values()];
}

export function reiniciarAlmacen() {
  pagos.clear();
  clavesIdempotencia.clear();
  webhooks.clear();
}
