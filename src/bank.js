// Un "banco" de mentira. Sirve para practicar qué pasa cuando el banco falla.
// En un sistema real aquí se llamaría al banco o a la red de tarjetas.

export function bancoSimulado({ probabilidadFallo = 0.3 } = {}) {
  return async function autorizar(pago) {
    if (Math.random() < probabilidadFallo) {
      throw new Error("Banco no disponible, intenta de nuevo");
    }
    return { autorizacion: `auth_${pago.id.slice(4, 12)}` };
  };
}
