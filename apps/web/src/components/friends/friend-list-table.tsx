'use client'

import { useState } from 'react'
import { PlusIcon, UserIcon } from '@phosphor-icons/react'
import { Banner } from '@cloudflare/kumo/components/banner'
import { Button } from '@cloudflare/kumo/components/button'
import { Empty } from '@cloudflare/kumo/components/empty'
import { Input } from '@cloudflare/kumo/components/input'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Select } from '@cloudflare/kumo/components/select'
import type { Tag } from '@line-crm/shared'
import type { FriendListItem } from '@/lib/api'
import { api } from '@/lib/api'
import FriendListRow from './friend-list-row'
import TagBadge from './tag-badge'

interface Props {
  friends: FriendListItem[]
  allTags: Tag[]
  onRefresh: () => void
}

export default function FriendListTable({ friends, allTags, onRefresh }: Props) {
  // Inline tag-management expander. The row's primary click navigates to
  // /chats; tag editing stays available here as a secondary action because
  // the chats page's FriendInfoSidebar currently only displays tags (no
  // add/remove). Without this expander operators would lose the only path
  // to mutate friend tags from the admin UI.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [addingTagForFriend, setAddingTagForFriend] = useState<string | null>(null)
  const [selectedTagId, setSelectedTagId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // 管理名 (nickname) 編集。LINE公式側の友だち名変更はAPIに露出しないため、
  // L Harness側で上書き表示する名前をここから保存する。空送信で解除。
  const [nicknameDraft, setNicknameDraft] = useState('')
  const [nicknameSaving, setNicknameSaving] = useState(false)

  const toggleExpand = (id: string) => {
    if (expandedId !== id) {
      const target = friends.find((f) => f.id === id)
      // Prefill with the current management name (empty = LINE name in use).
      setNicknameDraft(target?.nickname ?? '')
    }
    setExpandedId(expandedId === id ? null : id)
    setAddingTagForFriend(null)
    setSelectedTagId('')
    setError('')
  }

  const handleAddTag = async (friendId: string) => {
    if (!selectedTagId) return
    setLoading(true)
    setError('')
    try {
      await api.friends.addTag(friendId, selectedTagId)
      setAddingTagForFriend(null)
      setSelectedTagId('')
      onRefresh()
    } catch {
      setError('タグの追加に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveTag = async (friendId: string, tagId: string) => {
    setLoading(true)
    setError('')
    try {
      await api.friends.removeTag(friendId, tagId)
      onRefresh()
    } catch {
      setError('タグの削除に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  // 管理名保存。空文字は解除扱い (LINE表示名に戻る) — API が trim して NULL に溃す。
  const handleSaveNickname = async (friendId: string) => {
    setNicknameSaving(true)
    setError('')
    try {
      await api.friends.setDisplayName(friendId, nicknameDraft)
      onRefresh()
    } catch {
      setError('管理名の保存に失敗しました')
    } finally {
      setNicknameSaving(false)
    }
  }

  if (friends.length === 0) {
    return (
      <Empty size="sm" title="友だちが見つかりません" description="検索条件や絞り込みを変更してお試しください。" />
    )
  }

  return (
    <LayerCard className="overflow-hidden p-0">
      {error ? <Banner variant="error" title="タグを更新できませんでした" description={error} /> : null}

      {/* Header sits inside the same overflow container as the body so the
          column labels stay aligned with their values when the user scrolls
          horizontally on narrower viewports (e.g. desktop with sidebar open
          and the body forced to min-w-[900px]). */}
      <div className="overflow-x-auto">
        <div className="min-w-[900px]">
          <div className="hidden grid-cols-[80px_220px_120px_1fr_280px] gap-3 border-b border-kumo-line bg-kumo-tint px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-kumo-subtle lg:grid">
            <div>対応マーク</div>
            <div>名前</div>
            <div>シナリオ</div>
            <div>受信メッセージ</div>
            <div>★つきタグ・友だち情報</div>
          </div>
          {friends.map((friend) => {
            const isExpanded = expandedId === friend.id
            const isAddingTag = addingTagForFriend === friend.id
            const availableTags = allTags.filter(
              (t) => !friend.tags.some((ft) => ft.id === t.id),
            )

            return (
              <div key={friend.id}>
                <FriendListRow
                  friend={friend}
                  onTagEditClick={() => toggleExpand(friend.id)}
                />

                {isExpanded && (
                  <div className="space-y-3 border-b border-kumo-line bg-kumo-tint px-6 py-4">
                    <div>
                      <p className="mb-1 text-xs font-semibold text-kumo-subtle">LINE ユーザーID</p>
                      <p className="select-all break-all font-mono text-xs text-kumo-default">{friend.lineUserId}</p>
                    </div>
                    <div>
                      <p className="mb-1 text-xs font-semibold text-kumo-subtle">管理名</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          size="sm"
                          type="text"
                          value={nicknameDraft}
                          onChange={(e) => setNicknameDraft(e.target.value)}
                          placeholder="空欄のまま保存するとLINE表示名に戻る"
                          aria-label="管理名"
                          className="max-w-[280px] flex-1"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="primary"
                          icon={UserIcon}
                          onClick={() => handleSaveNickname(friend.id)}
                          disabled={nicknameSaving}
                          loading={nicknameSaving}
                        >
                          管理名を保存
                        </Button>
                      </div>
                      <p className="mt-1 text-[10px] text-kumo-subtle">
                        {friend.lineName ? (
                          <>LINE表示名: {friend.lineName}{friend.nickname ? ' → この画面の名前を優先表示します' : ''}</>
                        ) : null}
                      </p>
                    </div>
                    <p className="mb-2 text-xs font-semibold text-kumo-subtle">タグ管理</p>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {friend.tags.map((tag) => (
                        <TagBadge
                          key={tag.id}
                          tag={tag}
                          onRemove={() => handleRemoveTag(friend.id, tag.id)}
                        />
                      ))}
                    </div>

                    {isAddingTag ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          size="sm"
                          aria-label="追加するタグ"
                          value={selectedTagId}
                          onValueChange={(value) => setSelectedTagId(value ?? '')}
                          placeholder="タグを選択"
                          items={availableTags.map((tag) => ({ value: tag.id, label: tag.name }))}
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="primary"
                          onClick={() => handleAddTag(friend.id)}
                          disabled={!selectedTagId || loading}
                          loading={loading}
                        >
                          追加
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => { setAddingTagForFriend(null); setSelectedTagId('') }}
                        >
                          キャンセル
                        </Button>
                      </div>
                    ) : (
                      availableTags.length > 0 && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          icon={PlusIcon}
                          onClick={() => setAddingTagForFriend(friend.id)}
                        >
                          タグを追加
                        </Button>
                      )
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </LayerCard>
  )
}
