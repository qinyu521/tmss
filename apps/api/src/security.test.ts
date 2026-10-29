import { describe, expect, it } from 'vitest';
import { assertSupportedDeploymentMode, resolveTrustProxy } from './security.js';

describe('部署安全配置', () => {
  it('默认和单机模式允许启动', () => {
    expect(() => assertSupportedDeploymentMode({})).not.toThrow();
    expect(() => assertSupportedDeploymentMode({ SINGLE_PLAYER_MODE: '1' })).not.toThrow();
  });

  it('拒绝尚未实现用户鉴权与数据隔离的多用户模式', () => {
    expect(() => assertSupportedDeploymentMode({ SINGLE_PLAYER_MODE: '0' })).toThrow(
      /没有登录鉴权或按用户隔离存档/,
    );
  });

  it('false/no/off 等常见写法同样视为请求多用户模式（fail-closed）', () => {
    for (const value of ['false', 'FALSE', 'no', 'off', ' 0 ']) {
      expect(() => assertSupportedDeploymentMode({ SINGLE_PLAYER_MODE: value })).toThrow(
        /没有登录鉴权或按用户隔离存档/,
      );
    }
  });

  it('默认不信任转发头，只有显式配置时才信任一层代理', () => {
    expect(resolveTrustProxy({})).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: '0' })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: '1' })).toBe(1);
  });
});
