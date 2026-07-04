import type { Config } from '@react-router/dev/config';

// Watt Dashboard（M10）：RR7 framework mode 的 SPA 形态（ssr:false）——产物纯静态,
// build/client 由 package.json build 脚本落回 dist/,继续走 gateway assets 同域托管管道。
export default {
  ssr: false,
} satisfies Config;
