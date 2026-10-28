/**
 * Deployment safety gates for the current personal/single-player prototype.
 *
 * This project has no user authentication or per-user save isolation yet.
 * Do not let an environment flag advertise a multi-user mode that the API
 * does not actually secure.
 */
export function assertSupportedDeploymentMode(
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.SINGLE_PLAYER_MODE === '0') {
    throw new Error(
      [
        '安全启动失败：SINGLE_PLAYER_MODE=0 暂不受支持。',
        '当前版本没有登录鉴权或按用户隔离存档；启用所谓多用户模式会让不同访问者共享并操作同一批游戏。',
        '请设置 SINGLE_PLAYER_MODE=1，并将服务限制为个人使用（回环端口 + Cloudflare Access/受保护的反向代理）。',
        '多人模式必须先实现身份认证、游戏所有权校验、用户级数据隔离和安全测试。',
      ].join(' '),
    );
  }
}

/**
 * Trust exactly one reverse-proxy hop only when the operator explicitly opts in.
 * The default is false so arbitrary X-Forwarded-For headers cannot spoof req.ip.
 */
export function resolveTrustProxy(
  env: Record<string, string | undefined> = process.env,
): false | 1 {
  return env.TRUST_PROXY === '1' ? 1 : false;
}
