# Benchmark — Wave 0

**Compilador**: TypeScript original (V20, antes de Wave 1).
**Hardware**: Linux 6.8.0-142-generic, g++ 13.3.0.
**Ejemplos**: 69 (todos los de `examples/` excepto `tls-server` que requiere libssl).

## Tiempo de compilación

| Métrica | Valor |
|---------|------:|
| Total ejemplos | 69 |
| Suma de tiempos (mínimo por ejemplo) | 23.80s |
| Suma de tiempos (mediana) | 25.30s |
| Suma de tiempos (máximo) | 27.95s |
| Wall-clock real (3 runs × 69) | 77.06s |
| Promedio por ejemplo (mediana) | 367ms |

### Top 5 más lentos

| Ejemplo | Tiempo (mediana) |
|---------|-----------------:|
| async-files | 464ms |
| for-await-demo | 453ms |
| constexpr-demo | 449ms |
| closures | 447ms |
| constructor-demo | 441ms |

### Top 5 más rápidos

| Ejemplo | Tiempo (mediana) |
|---------|-----------------:|
| interface | 296ms |
| promise-all-race-demo | 296ms |
| io-uring-async-demo | 297ms |
| native-io | 315ms |
| instanceof-demo | 324ms |

## Tamaño del .cpp generado

| Métrica | Valor |
|---------|------:|
| Total .cpp generado | 106,354 bytes (~103 KB) |
| Promedio por ejemplo | 1,541 bytes |
| Más pequeño | hello.ets → 776 bytes |
| Más grande | match-v2-demo → 5,700 bytes |

## Golden tests

- **69 archivos .cpp** en `bootstrap/test/golden/`
- **100% estables** entre runs (verificado bit-by-bit con SHA-256)
- Hash promedio ~64 caracteres, sin colisiones
- Índice en `bootstrap/test/golden/INDEX.json`

## Gaps del dialecto detectados

Ver `bootstrap/docs/GAPS.md` para detalles.

| # | Feature | Impacto | Prioridad |
|---|---------|---------|-----------|
| 1 | `import type` | Wave 1 bloqueada | Alta |
| 2 | `array.push()` | Todas las clases con arrays | Alta |
| 3 | Object spread `{...a}` | Codegen TS | Media |
| 4 | Generic constraint completo | Type system | Media |
| 5 | Union con payload | Alternativa existe | Baja |

## Conclusiones

1. **El dialecto es viable** para Wave 1, 2, 3 (lex/parser/type-checker), aunque necesita los fixes de Gaps #1, #2, #4.
2. **Performance baseline**: ~25s para compilar 69 ejemplos. El compilador Estatic puede tardar 3-10× más (estimación pesimista) — sigue siendo viable para uso interactivo.
3. **Tamaño de golden tests**: 103 KB es manejable. La verificación bit-by-bit es realista.
4. **Estabilidad 100%**: los golden tests son confiables para detectar regressions.

## Plan para Wave 1

Antes de empezar Wave 1, cerrar **3 gaps críticos**:

1. **Gap #1**: soporte `import type` (15 min en parser)
2. **Gap #2**: añadir `array.push()` como built-in (1 hora en codegen)
3. **Gap #4**: completar generic constraints (2-3 horas en type-checker)

Total: ~4-5 horas de fixes del dialecto → Wave 1 puede migrar sin trabas.