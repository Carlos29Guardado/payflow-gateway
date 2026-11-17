// La firma: el "sello de lacre" de cada aviso que mandamos a una tienda.
//
// Problema: la tienda recibe un mensaje que dice "el pago X fue capturado".
// ¿Cómo sabe que realmente lo mandó PayFlow y no un impostor?
//
// Solución: PayFlow y la tienda comparten un secreto (una contraseña que solo
// ellos dos conocen). Con ese secreto PayFlow calcula una "firma" del mensaje.
// La tienda repite el cálculo: si le da la misma firma, el mensaje es auténtico
// y no fue modificado en el camino. Sin el secreto, nadie puede falsificarla.

import { createHmac, timingSafeEqual } from "node:crypto";

// Calcula la firma. Incluye la hora para que un mensaje viejo no se pueda reenviar.
export function firmar(secreto, cuerpo, marcaTiempo = Math.floor(Date.now() / 1000)) {
  const firma = createHmac("sha256", secreto)
    .update(`${marcaTiempo}.${cuerpo}`)
    .digest("hex");
  return `t=${marcaTiempo},v1=${firma}`;
}

// Esto lo haría la tienda al recibir el aviso: ¿la firma es válida?
export function verificar(secreto, cuerpo, cabecera, toleranciaSegundos = 300) {
  const partes = Object.fromEntries(cabecera.split(",").map((p) => p.split("=")));
  const marca = Number(partes.t);
  if (!marca || !partes.v1) return false;

  // Si el mensaje tiene más de 5 minutos, lo rechazamos (protege contra reenvíos).
  if (Math.abs(Date.now() / 1000 - marca) > toleranciaSegundos) return false;

  const esperada = firmar(secreto, cuerpo, marca).split("v1=")[1];
  const a = Buffer.from(esperada);
  const b = Buffer.from(partes.v1);
  // timingSafeEqual compara sin revelar pistas por el tiempo que tarda.
  return a.length === b.length && timingSafeEqual(a, b);
}
