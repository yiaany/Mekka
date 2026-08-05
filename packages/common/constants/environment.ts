// Mekka vendors Studio as a private local fork and never enables upstream hosted mode.
export const IS_PLATFORM: boolean = false
export const IS_PROD = process.env.NEXT_PUBLIC_VERCEL_ENV === 'production'
