/**
 * 飞书机器人自身 open_id 自查（GET /open-apis/bot/v3/info）——decode 判定 @机器人 需要 bot open_id。
 * 用 tenant_access_token 调用；结果由 worker 宿主做 isolate 级缓存（bot open_id 不变）。
 */

export interface BotInfoResponse {
  code?: number;
  msg?: string;
  bot?: { open_id?: string };
}

/** 取机器人 open_id；失败 → undefined（decode 退化为仅 p2p/字面量判定，不阻断入站）。 */
export async function fetchBotOpenId(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${baseUrl}/open-apis/bot/v3/info`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as BotInfoResponse;
    if (body.code === 0 && typeof body.bot?.open_id === 'string') return body.bot.open_id;
    return undefined;
  } catch {
    return undefined;
  }
}
