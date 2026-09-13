import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";

import { GeneratorStudio } from "@/components/create/generator-studio";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  value: vi.fn(() => "blob:preview"),
});

type StudioProps = ComponentProps<typeof GeneratorStudio>;
type Generation = NonNullable<StudioProps["initialGenerations"]>[number];
type Conversation = NonNullable<StudioProps["initialConversations"]>[number];

const EMPTY_STATE_TEXT = "你好，你想创作什么？";
const ACTIVE_CONVERSATION_ID = "narra_active_conversation_id";

function mockLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
  });
}

const baseProps = {
  checkInSummary: {
    checkInReward: 50,
    checkedInToday: false,
  },
  currentUser: {
    credits: 500,
    role: "user" as const,
  },
};

function createSucceededGeneration(overrides: Partial<Generation> = {}): Generation {
  return {
    conversationId: null,
    count: 1,
    createdAt: "2026-04-23T08:00:00.000Z",
    creditsSpent: 5,
    generationType: "text_to_image",
    id: "job_1",
    images: [
      {
        actualHeight: 1024,
        actualSize: "1024x1024",
        actualWidth: 1024,
        id: "image_1",
        url: "https://example.com/image.png",
      },
    ],
    model: "gpt-image-2",
    moderation: "auto",
    negativePrompt: null,
    outputCompression: null,
    outputFormat: "png",
    prompt: "会话内的图",
    providerMode: "built_in",
    quality: "auto",
    size: "1024x1024",
    sourceImageUrl: null,
    sourceImageUrls: [],
    status: "succeeded",
    ...overrides,
  };
}

function createConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    createdAt: "2026-04-23T08:00:00.000Z",
    generationIds: [],
    id: "conversation_1",
    title: "新对话",
    ...overrides,
  };
}

describe("创作台：会话视图与历史 generation 隔离", () => {
  beforeEach(() => {
    mockLocalStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        json: async () => ({ data: {} }),
        ok: true,
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("会话列表为空时不展示孤儿 generation", () => {
    render(
      <GeneratorStudio
        {...baseProps}
        initialConversations={[]}
        initialGenerations={[
          createSucceededGeneration({ id: "job_orphan", prompt: "已删除会话的图" }),
        ]}
      />,
    );

    expect(screen.getByText(EMPTY_STATE_TEXT)).toBeInTheDocument();
    expect(screen.queryByText("已删除会话的图")).toBeNull();
  });

  it("有活跃会话时正常展示该会话的 generation", () => {
    render(
      <GeneratorStudio
        {...baseProps}
        initialConversations={[
          createConversation({ generationIds: ["job_1"], title: "会话一" }),
        ]}
        initialGenerations={[
          createSucceededGeneration({ conversationId: "conversation_1", id: "job_1" }),
        ]}
      />,
    );

    expect(screen.getByText("会话内的图")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_STATE_TEXT)).toBeNull();
  });

  it("删除活跃会话后中间清空，且服务端 props 刷新不会让内容复活", async () => {
    const user = userEvent.setup();
    const conversations = [
      createConversation({ generationIds: ["job_1"], title: "会话一" }),
    ];
    const generations = [
      createSucceededGeneration({ conversationId: "conversation_1", id: "job_1" }),
    ];

    const { rerender } = render(
      <GeneratorStudio
        {...baseProps}
        initialConversations={conversations}
        initialGenerations={generations}
      />,
    );
    expect(screen.getByText("会话内的图")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "删除会话 会话一" }));

    await waitFor(() => {
      expect(screen.queryByText("会话内的图")).toBeNull();
    });
    expect(screen.getByText(EMPTY_STATE_TEXT)).toBeInTheDocument();

    // 模拟 router.refresh()：服务端重新下发新引用的 props（可能仍是删除前的快照）。
    rerender(
      <GeneratorStudio
        {...baseProps}
        initialConversations={[...conversations]}
        initialGenerations={[...generations]}
      />,
    );

    expect(screen.queryByText("会话内的图")).toBeNull();
    expect(screen.getByText(EMPTY_STATE_TEXT)).toBeInTheDocument();
  });

  it("点击新建对话后服务端 props 刷新不会拉回旧会话", async () => {
    const user = userEvent.setup();
    const conversations = [
      createConversation({ generationIds: ["job_1"], title: "会话一" }),
    ];
    const generations = [
      createSucceededGeneration({ conversationId: "conversation_1", id: "job_1" }),
    ];

    const { rerender } = render(
      <GeneratorStudio
        {...baseProps}
        initialConversations={conversations}
        initialGenerations={generations}
      />,
    );
    expect(screen.getByText("会话内的图")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /新建对话/ })[0]);

    await waitFor(() => {
      expect(screen.queryByText("会话内的图")).toBeNull();
    });

    rerender(
      <GeneratorStudio
        {...baseProps}
        initialConversations={[...conversations]}
        initialGenerations={[...generations]}
      />,
    );

    expect(screen.queryByText("会话内的图")).toBeNull();
    expect(screen.getByText(EMPTY_STATE_TEXT)).toBeInTheDocument();
  });

  it("刷新页面时恢复 localStorage 记录的上次活跃会话", () => {
    mockLocalStorage({ [ACTIVE_CONVERSATION_ID]: "conversation_2" });

    render(
      <GeneratorStudio
        {...baseProps}
        initialConversations={[
          createConversation({
            createdAt: "2026-04-24T08:00:00.000Z",
            generationIds: [],
            id: "conversation_1",
            title: "更新的会话",
          }),
          createConversation({ generationIds: ["job_2"], id: "conversation_2", title: "上次活跃" }),
        ]}
        initialGenerations={[
          createSucceededGeneration({
            conversationId: "conversation_2",
            id: "job_2",
            prompt: "上次活跃会话的图",
          }),
        ]}
      />,
    );

    expect(screen.getByText("上次活跃会话的图")).toBeInTheDocument();
  });
});
