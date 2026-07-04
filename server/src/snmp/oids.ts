/**
 * OIDs de referencia para Ubiquiti airMAX y Mimosa.
 *
 * Se consultan por WALK de subárbol (no GET puntual) porque los índices de
 * tabla varían entre firmwares; las columnas se identifican por su posición
 * dentro del subárbol, que es estable.
 */

// ---------- Ubiquiti airMAX (enterprise 41112) ----------
// UBNT-AirMAX-MIB :: ubntWlStatTable (una fila por radio, normalmente índice 1)
export const UBNT_WLSTAT_TABLE = '1.3.6.1.4.1.41112.1.4.5.1';
export const UBNT_WLSTAT_COLS: Record<string, string> = {
  '5': 'signal_dbm',      // ubntWlStatSignal
  '6': 'rssi',            // ubntWlStatRssi
  '7': 'ccq_pct',         // ubntWlStatCcq
  '8': 'noise_dbm',       // ubntWlStatNoiseFloor
  '9': 'tx_rate_mbps',    // ubntWlStatTxRate
  '10': 'rx_rate_mbps',   // ubntWlStatRxRate
  '15': 'stations',       // ubntWlStatStaCount
};

// UBNT-AirMAX-MIB :: ubntAirMaxTable
export const UBNT_AIRMAX_TABLE = '1.3.6.1.4.1.41112.1.4.6.1';
export const UBNT_AIRMAX_COLS: Record<string, string> = {
  '3': 'airmax_quality_pct',   // ubntAirMaxQuality
  '4': 'airmax_capacity_pct',  // ubntAirMaxCapacity
};

// ---------- Mimosa (enterprise 43356) ----------
// MIMOSA-NETWORKS-BFIVE-MIB — B5/B5c/C5 PTP.
// mimosaChainTable: potencia RX y SNR por cadena.
export const MIMOSA_CHAIN_TABLE = '1.3.6.1.4.1.43356.2.1.2.6.2.1';
export const MIMOSA_CHAIN_COLS: Record<string, string> = {
  '2': 'signal_dbm', // mimosaChainRxPower (a veces en centésimas de dB)
  '4': 'snr_db',     // mimosaChainSnr
};
// Throughput PHY actual (escalares .0)
export const MIMOSA_PHY_TX = '1.3.6.1.4.1.43356.2.1.2.5.1.0'; // mimosaCurrentTxPhy (kbps)
export const MIMOSA_PHY_RX = '1.3.6.1.4.1.43356.2.1.2.5.2.0'; // mimosaCurrentRxPhy (kbps)

// ---------- IF-MIB estándar (tráfico de cualquier equipo SNMP) ----------
export const IF_NAME = '1.3.6.1.2.1.31.1.1.1.1';       // ifName
export const IF_HC_IN_OCTETS = '1.3.6.1.2.1.31.1.1.1.6';  // ifHCInOctets
export const IF_HC_OUT_OCTETS = '1.3.6.1.2.1.31.1.1.1.10'; // ifHCOutOctets

// SNMPv2-MIB básicos para "probar conexión"
export const SYS_DESCR = '1.3.6.1.2.1.1.1.0';
export const SYS_NAME = '1.3.6.1.2.1.1.5.0';
export const SYS_UPTIME = '1.3.6.1.2.1.1.3.0';
