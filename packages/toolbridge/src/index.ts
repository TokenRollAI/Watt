/**
 * watt-toolbridge Worker 入口。
 *
 * Tool Bridge 作为独立项目提供 Worker + SDK。Watt 只嵌入 Worker factory，不再 vendored 上游源码；
 * Gateway 侧通过 Host/Admin SDK 走 service binding 调用本 Worker。
 */

import { createBridge } from '@tokenroll/tool-bridge/worker';

export default createBridge();
