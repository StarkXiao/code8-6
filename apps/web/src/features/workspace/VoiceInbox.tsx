import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as AntApp, Button, List, Popconfirm, Select, Space, Tag } from 'antd';
import { AudioOutlined, DeleteOutlined, InboxOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AudioAttachmentDto, WorkspaceRole } from '@froa/shared';
import { audioApi, workspaceApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { formatMs } from '../../components/Waveform';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';

interface VoiceInboxProps {
  workspaceId: string;
  /** 当前用户在这个空间里的角色：归食谱、删录音是整理工作，只有整理者及以上能做 */
  myRole: WorkspaceRole | undefined;
  recipes: { id: string; title: string }[];
}

/**
 * 语音收件箱 —— 长辈极简端（/talk）录的话先落在这里，还没归到任何食谱。
 *
 * 整理者的工作：听一遍 → 归到对应食谱 → 自动跳到录音工作台继续转写、框选、标记。
 * 长辈本人永远看不到这个列表，也不需要知道它的存在。
 */
export function VoiceInbox({ workspaceId, myRole, recipes }: VoiceInboxProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const { playAudio } = useAudioPlayback();
  const [assignTarget, setAssignTarget] = useState<Record<string, string>>({});

  const inbox = useQuery({
    queryKey: ['audio-inbox', workspaceId],
    queryFn: () => audioApi.list({ workspaceId, unassigned: true }),
  });

  const members = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => workspaceApi.members(workspaceId),
  });

  const canOrganize = myRole === 'owner' || myRole === 'editor';
  const memberName = (userId: string) =>
    members.data?.find((member) => member.userId === userId)?.displayName ?? '家人';

  const assignMutation = useMutation({
    mutationFn: ({ audioId, recipeId }: { audioId: string; recipeId: string }) =>
      audioApi.assign(audioId, recipeId),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['audio-inbox', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['audio'] });
      message.success('已归到食谱，接下来去转写和整理');
      // 直接落到这段语音上，整理者不用再找一遍
      navigate(`/w/${workspaceId}/recipes/${updated.recipeId}/record?audio=${updated.id}`);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const removeMutation = useMutation({
    mutationFn: (audioId: string) => audioApi.remove(audioId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['audio-inbox', workspaceId] });
      message.success('已从收件箱移除（原文件仍保留，结论仍可追溯）');
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const items = inbox.data ?? [];
  if (!items.length && !inbox.isLoading) return null;

  return (
    <div className="froa-card" style={{ marginBottom: '1rem' }}>
      <h3 className="froa-card-title">
        <InboxOutlined /> 待整理语音{items.length ? `（${items.length}）` : ''}
      </h3>
      <div className="froa-hint" style={{ marginBottom: '0.75rem' }}>
        长辈在极简页按住说的话会先到这里。听一遍，归到对应的食谱，再转写、整理 ——
        这些都不用长辈动手。
      </div>

      <List
        size="small"
        loading={inbox.isLoading}
        dataSource={items}
        renderItem={(item: AudioAttachmentDto) => (
          <List.Item
            actions={[
              <Button
                key="play"
                type="link"
                icon={<AudioOutlined />}
                onClick={() => playAudio(item, { label: '待整理语音' })}
              >
                播放
              </Button>,
              canOrganize ? (
                <Space key="assign" size={4}>
                  <Select
                    size="small"
                    placeholder="归到食谱…"
                    style={{ minWidth: 140 }}
                    value={assignTarget[item.id]}
                    onChange={(value) => setAssignTarget((prev) => ({ ...prev, [item.id]: value }))}
                    options={recipes.map((recipe) => ({ value: recipe.id, label: recipe.title }))}
                  />
                  <Button
                    size="small"
                    type="primary"
                    disabled={!assignTarget[item.id]}
                    loading={assignMutation.isPending && assignMutation.variables?.audioId === item.id}
                    onClick={() =>
                      assignMutation.mutate({ audioId: item.id, recipeId: assignTarget[item.id]! })
                    }
                  >
                    归到食谱
                  </Button>
                </Space>
              ) : null,
              canOrganize ? (
                <Popconfirm
                  key="remove"
                  title="从收件箱移除这段语音？"
                  description="只是不再显示，原文件仍保留。"
                  okText="移除"
                  cancelText="取消"
                  onConfirm={() => removeMutation.mutate(item.id)}
                >
                  <Button type="link" danger icon={<DeleteOutlined />} aria-label="移除" />
                </Popconfirm>
              ) : null,
            ].filter(Boolean)}
          >
            <List.Item.Meta
              title={`${memberName(item.ownerId)} · ${formatMs(item.durationMs)}`}
              description={new Date(item.createdAt).toLocaleString('zh-CN', {
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
              })}
            />
            {item.transcriptStatus !== 'done' && <Tag>待转写</Tag>}
          </List.Item>
        )}
      />
    </div>
  );
}
