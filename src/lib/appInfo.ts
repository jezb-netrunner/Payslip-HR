// The software's name and version, as registered with the BIR and printed on
// every system-generated report (RMO 9-2021 Annex B). A new version that
// changes how the system computes or keeps records is an enhancement the
// client tells the BIR about before using it.

export const APP_NAME = 'Payslip HR'
export const APP_VERSION = __APP_VERSION__
export const APP_BUILD = __APP_BUILD__

/** "Payslip HR v1.0.0 (build 1a2b3c4)" */
export const SOFTWARE = `${APP_NAME} v${APP_VERSION}${APP_BUILD && APP_BUILD !== 'dev' ? ` (build ${APP_BUILD})` : ''}`
