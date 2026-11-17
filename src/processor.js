// El procesador: lo que hace el trabajador con cada pago que saca de la fila.

import { obtenerPago, actualizarPago } from "./store.js";

// "banco" es la función que autoriza el pago; "eventos" es el megáfono
// por el que avisamos a quien quiera enterarse (en la pieza 3: los webhooks).
// "agenteFraude" es opcional: si existe, revisa el pago antes de llamar al banco.
export function crearProcesadorPagos({ banco, eventos, agenteFraude = null }) {
  return async function procesar({ idPago }) {
    const pago = obtenerPago(idPago);
    actualizarPago(idPago, { estado: "procesando", intentos: pago.intentos + 1 });

    // Si el agente falla, esta línea lanza un error y la cola reintenta, igual que con el banco.
    // Si ya hay veredicto (porque fue el banco el que falló), no se vuelve a preguntar.
    if (agenteFraude && !pago.fraude) {
      const { monto, moneda, descripcion } = pago;
      const veredicto = await agenteFraude({ monto, moneda, descripcion });
      actualizarPago(idPago, { fraude: veredicto });

      if (veredicto.decision === "rechazar") {
        actualizarPago(idPago, { estado: "rechazado" });
        eventos.emit("pago.rechazado", obtenerPago(idPago));
        return;
      }
      if (veredicto.decision === "revisar") {
        actualizarPago(idPago, { estado: "en_revision" });
        eventos.emit("pago.en_revision", obtenerPago(idPago));
        return;
      }
    }

    // Si el banco falla, esta línea lanza un error y la cola se encarga de reintentar.
    const respuesta = await banco(pago);

    actualizarPago(idPago, { estado: "capturado", autorizacion: respuesta.autorizacion });
    eventos.emit("pago.capturado", obtenerPago(idPago));
  };
}
