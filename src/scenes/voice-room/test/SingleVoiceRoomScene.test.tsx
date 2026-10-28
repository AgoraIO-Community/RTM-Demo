import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createVoiceRoomFakes } from './testing';
import { VoiceRoomScene } from '../VoiceRoomScene';
import { encodeVoiceRoomUrlPayload } from '../voice-room-url';

const env = { configured: true, appId: 'test-app-id', source: 'window.__ENV__' } as const;

describe('单端语聊房入口', () => {
  it('首次只展示 Host/Audience 选择，不创建任何隐藏客户端', async () => {
    const fakes = createVoiceRoomFakes();
    render(<VoiceRoomScene env={env} overrides={fakes.overrides} />);

    expect(await screen.findByTestId('voice-room-entry')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建并进入' })).toBeDisabled();
    expect(screen.getByLabelText('加入的房间名称')).toBeInTheDocument();
    expect(screen.queryByLabelText('邀请链接')).not.toBeInTheDocument();
  });

  it('Audience 邀请 URL 在平台登录阶段展示 loading，不停在加入表单', async () => {
    const fakes = createVoiceRoomFakes();
    const data = encodeVoiceRoomUrlPayload({
      version: 2,
      nameKey: `vrn-v1-${'a'.repeat(43)}`,
      roomId: 'voice-room-invite',
      role: 'audience',
      pageUid: null,
      nickname: null,
    });
    render(<VoiceRoomScene env={env} overrides={fakes.overrides} search={`?data=${data}`} />);

    expect(screen.getByTestId('voice-room-booting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '加入房间' })).not.toBeInTheDocument();
    expect(screen.queryByText('voice-room-invite')).not.toBeInTheDocument();
  });
});
