// Дев-энтрипоинт (tsx watch): включает вход без Telegram ДО импорта config.
// В прод-бандл не попадает (esbuild собирает src/index.ts); в prod AUTH_DEV_BYPASS
// дополнительно запрещён assertAuthConfig.
process.env.AUTH_DEV_BYPASS ??= '1';
await import('./index');

export {};
