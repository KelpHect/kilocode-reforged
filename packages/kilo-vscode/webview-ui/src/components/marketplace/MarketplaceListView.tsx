import { createSignal, createMemo, For, Show } from "solid-js"
import { debounce } from "@solid-primitives/scheduled"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Select } from "@kilocode/kilo-ui/select"
import { Tag } from "@kilocode/kilo-ui/tag"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import type {
  MarketplaceItem,
  McpMarketplaceItem,
  SkillMarketplaceItem,
  MarketplaceInstalledMetadata,
} from "../../types/marketplace"
import { useLanguage } from "../../context/language"
import { isInstalled } from "./utils"
import { ItemCard } from "./ItemCard"
import { MarketplaceContribute } from "./MarketplaceContribute"

interface StatusOption {
  value: string
  label: string
}

interface Props {
  items: MarketplaceItem[]
  metadata: MarketplaceInstalledMetadata
  fetching: boolean
  type: "mcp" | "mode" | "skill"
  searchPlaceholder: string
  emptyMessage: string
  onInstall: (item: MarketplaceItem) => void
  onRemove: (item: MarketplaceItem, scope: "project" | "global") => void
}

export const MarketplaceListView = (props: Props) => {
  const { t } = useLanguage()
  // Two-tier search state: `searchInput` is bound to the TextField and reflects
  // every keystroke; `search` is debounced and drives `filtered`. The previous
  // implementation re-ran the O(n) lowercase filter on every keystroke against
  // 1800-item lists, causing visible typing latency.
  const [searchInput, setSearchInput] = createSignal("")
  const [search, setSearch] = createSignal("")
  const debouncedSetSearch = debounce((v: string) => setSearch(v), 100)
  const onSearchInput = (v: string) => {
    setSearchInput(v)
    debouncedSetSearch(v)
  }
  const [status, setStatus] = createSignal<StatusOption>({ value: "all", label: t("marketplace.filter.all") })
  const [tags, setTags] = createSignal<string[]>([])

  // Pre-build a lowercased search index per item — `id|name|description|author
  // |displayName` joined into a single string for substring matching. Built
  // once per items reference; re-runs only when the upstream marketplace
  // payload changes (rare). Avoids repeatedly lowercasing every field on
  // every keystroke for 1800 items.
  const searchIndex = createMemo(() => {
    const idx = new Map<string, string>()
    for (const item of props.items) {
      const skill = item.type === "skill" ? (item as SkillMarketplaceItem) : undefined
      const parts = [
        item.id,
        item.name,
        item.description,
        item.author ?? "",
        skill?.displayName ?? "",
      ]
      idx.set(item.id, parts.join("\n").toLowerCase())
    }
    return idx
  })

  const options = (): StatusOption[] => [
    { value: "all", label: t("marketplace.filter.all") },
    { value: "installed", label: t("marketplace.filter.installed") },
    { value: "notInstalled", label: t("marketplace.filter.notInstalled") },
  ]

  const tagsFor = (item: MarketplaceItem): string[] => {
    if (item.type === "skill") return [(item as SkillMarketplaceItem).displayCategory]
    return item.tags ?? []
  }

  const allTags = createMemo(() => {
    const counts = new Map<string, number>()
    for (const item of props.items) {
      for (const tag of tagsFor(item)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    const min = props.type === "mcp" ? 5 : 1
    return Array.from(counts.entries())
      .filter(([, n]) => n >= min)
      .map(([tag]) => tag)
      .sort()
  })

  const toggleTag = (tag: string) => {
    const current = tags()
    if (current.includes(tag)) {
      setTags(current.filter((t) => t !== tag))
    } else {
      setTags([...current, tag])
    }
  }

  const filtered = createMemo(() => {
    const q = search().toLowerCase()
    const s = status().value
    const active = tags()
    const idx = searchIndex()
    return props.items.filter((item) => {
      if (s === "installed" && !isInstalled(item.id, item.type, props.metadata)) return false
      if (s === "notInstalled" && isInstalled(item.id, item.type, props.metadata)) return false
      if (active.length > 0 && !active.some((tag) => tagsFor(item).includes(tag))) return false
      if (!q) return true
      const haystack = idx.get(item.id)
      return haystack ? haystack.includes(q) : false
    })
  })

  return (
    <div class="marketplace-list">
      <div class="marketplace-filters">
        <div class="marketplace-search-field">
          <TextField placeholder={props.searchPlaceholder} value={searchInput()} onChange={onSearchInput} />
        </div>
        <Select
          options={options()}
          current={status()}
          value={(o: StatusOption) => o.value}
          label={(o: StatusOption) => o.label}
          onSelect={(v: StatusOption | undefined) => v && setStatus(v)}
        />
      </div>
      <Show when={allTags().length > 0}>
        <div class="marketplace-active-tags">
          <For each={allTags()}>
            {(tag) => (
              <button
                class="marketplace-tag-filter"
                classList={{ active: tags().includes(tag) }}
                onClick={() => toggleTag(tag)}
              >
                <Tag>{tag}</Tag>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show
        when={!props.fetching}
        fallback={
          <div class="marketplace-loading">
            <Spinner />
          </div>
        }
      >
        <Show
          when={filtered().length > 0}
          fallback={
            <div class="marketplace-empty">
              <span class="marketplace-empty-message">{props.emptyMessage}</span>
              <MarketplaceContribute />
            </div>
          }
        >
          <div class="marketplace-grid">
            <For each={filtered()}>
              {(item) => {
                const skill = item.type === "skill" ? (item as SkillMarketplaceItem) : undefined
                const mcp = item.type === "mcp" ? (item as McpMarketplaceItem) : undefined
                return (
                  <ItemCard
                    item={item}
                    metadata={props.metadata}
                    displayName={skill?.displayName}
                    linkUrl={skill?.githubUrl ?? mcp?.url}
                    onInstall={props.onInstall}
                    onRemove={props.onRemove}
                    footer={<For each={tagsFor(item)}>{(tag) => <Tag>{tag}</Tag>}</For>}
                  />
                )
              }}
            </For>
          </div>
          <MarketplaceContribute />
        </Show>
      </Show>
    </div>
  )
}
