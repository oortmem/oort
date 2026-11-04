declare module 'cloudflare:workers' {
  export const env: {
    DB: import('./server/waitlist').D1Like;
  };
}
