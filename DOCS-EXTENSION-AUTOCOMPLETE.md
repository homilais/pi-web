# 需求文档：pi-web 扩展自动补全支持

## 背景

**问题：** pi-web 的 `ExtensionUIContext.addAutocompleteProvider()` 是空操作 (`() => {}`)，导致扩展注册的自动补全 provider 在 pi-web 中不生效。

**现状：**
- Terminal 模式：完整支持扩展自动补全
- pi-web 模式：`addAutocompleteProvider` 是 no-op，扩展无法提供补全建议

**相关扩展：** `skill-discover` 扩展支持 `@skill:` 自动补全，在 terminal 中可用，但在 pi-web 中不可用。

---

## 功能需求

### 1. 服务端：扩展自动补全注册

**目标：** 允许扩展注册自动补全 provider，存储供后续查询。

**修改位置：** `lib/rpc-manager.ts`

**具体要求：**
- 添加 `autocompleteProviders: AutocompleteProvider[]` 数组存储 provider
- 实现 `addAutocompleteProvider(factory)` 方法，将 provider 加入数组
- Provider 需要支持链式调用（后注册的可以访问先注册的）

**当前代码（no-op）：**
```typescript
addAutocompleteProvider: () => {},
```

**目标代码：**
```typescript
private autocompleteProviders: AutocompleteProvider[] = [];

addAutocompleteProvider: (factory) => {
  try {
    const current = this.autocompleteProviders.length > 0
      ? this.autocompleteProviders[this.autocompleteProviders.length - 1]
      : null;
    const next = current ? factory(current) : factory();
    this.autocompleteProviders.push(next);
    return next;
  } catch (e) {
    console.error('[pi-web] addAutocompleteProvider error:', e.message);
  }
},
```

---

### 2. 服务端：自动补全请求处理

**目标：** 客户端可以发送请求查询自动补全建议，服务端返回结果。

**修改位置：** `lib/rpc-manager.ts`

**协议设计：**

**请求格式（客户端 → 服务端）：**
```typescript
{
  type: 'get_autocomplete',
  requestId: string,        // 请求 ID，用于匹配响应
  prefix: string,           // 用户输入的查询文本
  trigger: string,          // 触发字符，如 '@skill:'
}
```

**响应格式（服务端 → 客户端）：**
```typescript
{
  type: 'autocomplete_result',
  requestId: string,        // 与请求 ID 匹配
  items: Array<{
    value: string,          // 补全值
    label: string,          // 显示标签
    description?: string,   // 描述
  }>,
  prefix: string,           // 触发前缀
}
```

**修改内容：**
1. 在 `send()` 方法的 switch 中添加 `case "get_autocomplete"`
2. 添加 `handleAutocompleteRequest(command)` 方法
3. 调用 `autocompleteProviders` 中的最后一个 provider 的 `getSuggestions()`
4. 通过 `emit()` 发送 `autocomplete_result` 响应

**目标代码：**
```typescript
case "get_autocomplete": {
  this.handleAutocompleteRequest(command);
  return null;
}

private async handleAutocompleteRequest(command: {
  requestId: string;
  prefix: string;
  trigger: string;
}): Promise<void> {
  const provider = this.autocompleteProviders[
    this.autocompleteProviders.length - 1
  ];
  
  if (!provider) {
    this.emit({
      type: 'autocomplete_result',
      requestId: command.requestId,
      items: [],
      prefix: command.trigger,
    } as AgentEvent);
    return;
  }
  
  try {
    const suggestions = await provider.getSuggestions(
      [],           // lines (web 模式无多行编辑器)
      0,            // cursorLine
      0,            // cursorCol
      {
        signal: new AbortController().signal,
        force: true,
      }
    );
    
    this.emit({
      type: 'autocomplete_result',
      requestId: command.requestId,
      items: suggestions?.items || [],
      prefix: suggestions?.prefix || command.trigger,
    } as AgentEvent);
  } catch (e) {
    console.error('[pi-web] handleAutocompleteRequest error:', e.message);
    this.emit({
      type: 'autocomplete_result',
      requestId: command.requestId,
      items: [],
      prefix: command.trigger,
    } as AgentEvent);
  }
}
```

---

### 3. 客户端：发送自动补全请求

**目标：** 用户输入 `@skill:` 时，发送请求到服务端查询建议。

**修改位置：** `components/ChatInput.tsx`

**具体要求：**
1. 添加 `extensionSuggestions` 状态存储建议
2. 修改 `@` 检测逻辑，支持 `@skill:` 模式
3. 添加 `sendAutocompleteRequest()` 函数
4. 添加请求去耦（debounce 200-300ms）
5. 添加超时处理（3 秒）

**目标代码：**
```typescript
const [extensionSuggestions, setExtensionSuggestions] = useState([]);
const autocompleteRequestTimer = useRef<NodeJS.Timeout>();
const autocompleteRequestController = useRef<AbortController>();

async function sendAutocompleteRequest(prefix: string, trigger: string) {
  // 取消之前的请求
  if (autocompleteRequestController.current) {
    autocompleteRequestController.current.abort();
  }
  
  // 去耦
  if (autocompleteRequestTimer.current) {
    clearTimeout(autocompleteRequestTimer.current);
  }
  
  autocompleteRequestTimer.current = setTimeout(async () => {
    const controller = new AbortController();
    autocompleteRequestController.current = controller;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    try {
      const response = await fetch('/api/agent/current/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'get_autocomplete',
          requestId,
          prefix,
          trigger,
        }),
        signal: controller.signal,
      });
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      
      if (data.type === 'autocomplete_result' && data.requestId === requestId) {
        setExtensionSuggestions(data.items || []);
      }
    } catch (e) {
      if (e instanceof Error && e.name !== 'AbortError') {
        console.error('[pi-web] autocomplete request error:', e.message);
      }
      setExtensionSuggestions([]);
    }
  }, 250);
}
```

---

### 4. 客户端：接收自动补全响应

**目标：** 监听 `autocomplete_result` 消息，更新建议列表。

**修改位置：** `hooks/useAgentSession.ts` 或消息处理逻辑

**具体要求：**
1. 在 SSE 消息处理中添加 `autocomplete_result` case
2. 根据 `requestId` 匹配请求，更新状态

**目标代码：**
```typescript
case 'autocomplete_result': {
  // 更新 extensionSuggestions 状态
  setExtensionSuggestions(data.items || []);
  break;
}
```

---

### 5. 客户端：弹窗渲染

**目标：** 在现有 `@` 文件补全弹窗中显示扩展建议。

**修改位置：** `components/ChatInput.tsx`

**具体要求：**
1. 当 `trigger === '@skill:'` 时，显示扩展建议而非文件列表
2. 扩展建议用特殊标记区分（如 ⚡ 图标）
3. 支持键盘导航（↑↓ Tab Enter Escape）
4. 选中后插入补全值

**目标逻辑：**
```typescript
// 计算弹窗数据源
const popupItems = useMemo(() => {
  if (atQuery?.trigger === '@skill:') {
    // 扩展建议
    return extensionSuggestions.map(item => ({
      ...item,
      isExtension: true,
    }));
  }
  // 文件 mention
  return filteredFileEntries;
}, [atQuery, extensionSuggestions, filteredFileEntries]);
```

---

## 架构设计

### 消息流

```
用户输入 @skill:co
    ↓
ChatInput.tsx 检测 @skill: 模式
    ↓
sendAutocompleteRequest('co', '@skill:')
    ↓
POST /api/agent/current/messages
{ type: 'get_autocomplete', requestId, prefix: 'co', trigger: '@skill:' }
    ↓
rpc-manager.ts handleAutocompleteRequest()
    ↓
调用 autocompleteProviders[last].getSuggestions()
    ↓
扩展返回建议列表
    ↓
emit({ type: 'autocomplete_result', requestId, items, prefix })
    ↓
SSE 推送到客户端
    ↓
ChatInput.tsx 接收并更新 extensionSuggestions
    ↓
弹窗显示建议
```

### 数据流

```
服务端:
  扩展注册 provider → autocompleteProviders 数组
  
客户端:
  用户输入 → 检测 @skill: → 发送请求 → 接收响应 → 更新状态 → 渲染弹窗
```

---

## 测试方案

### 单元测试

1. **服务端：**
   - `addAutocompleteProvider` 正确存储 provider
   - `handleAutocompleteRequest` 正确调用 provider 并返回结果
   - 无 provider 时返回空列表
   - provider 抛错时返回空列表

2. **客户端：**
   - `@skill:` 模式检测正确
   - 请求去耦（快速输入时只发最后一次）
   - 超时处理（3 秒后取消）
   - 键盘导航（↑↓ Tab Enter Escape）

### 集成测试

1. 启动 pi-web + 测试扩展
2. 输入 `@skill:` 应看到建议弹窗
3. 输入 `@skill:co` 应过滤到包含 "co" 的建议
4. Tab/Enter 选中应插入选中的值
5. Escape 应关闭弹窗

### 测试扩展

```typescript
// test-autocomplete.ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI) return;
    
    ctx.ui.addAutocompleteProvider((current) => {
      return {
        ...current,
        triggerCharacters: ['@skill:'],
        
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const line = lines[cursorLine] ?? '';
          const before = line.slice(0, cursorCol);
          const match = /@skill:(\w*)$/.exec(before);
          
          if (!match) return null;
          
          const query = match[1].toLowerCase();
          const skills = [
            { value: 'code-review', label: 'code-review', description: 'Review code' },
            { value: 'tdd', label: 'tdd', description: 'Test-driven development' },
            { value: 'research', label: 'research', description: 'Investigate a topic' },
          ];
          
          const filtered = skills.filter(s =>
            s.value.toLowerCase().includes(query)
          );
          
          return {
            items: filtered,
            prefix: '@skill:' + query,
          };
        },
        
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return {
            lines,
            cursorLine,
            cursorCol: cursorCol + item.value.length,
          };
        }
      };
    });
  });
}
```

---

## 兼容性

### 向后兼容

- ✅ 不影响现有扩展
- ✅ 不影响现有 `@` 文件补全
- ✅ 无 provider 时返回空列表，不报错
- ✅ 请求失败时静默降级

### 版本要求

- pi-web: 0.10.0+
- pi-coding-agent: 1.0.0+

---

## 参考资料

### pi-web 源码结构

```
lib/
  rpc-manager.ts          # 服务端 RPC 管理（ExtensionUIContext 实现）
  pi-types.ts             # 类型定义（ExtensionUiContextLike）
  file-fuzzy.ts           # @-mention 检测逻辑

components/
  ChatInput.tsx           # 客户端输入框（@-mention 弹窗）

app/
  page.tsx                # 主页面
```

### 关键代码位置

| 文件 | 位置 | 内容 |
|------|------|------|
| `lib/rpc-manager.ts` | L1758 | `createExtensionUiContext()` |
| `lib/rpc-manager.ts` | L1173 | `send()` case 分发 |
| `components/ChatInput.tsx` | L24902 | `atQuery` 状态变量 |
| `lib/file-fuzzy.ts` | - | `extractAtQuery()` 函数 |

### 现有 API

**ExtensionUIContext:**
```typescript
interface ExtensionUiContextLike {
  addAutocompleteProvider: (factory: AutocompleteProviderFactory) => void;
  // ... other methods
}
```

**AutocompleteProvider:**
```typescript
interface AutocompleteProvider {
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean }
  ): Promise<AutocompleteSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string
  ): { lines: string[]; cursorLine: number; cursorCol: number };
}

interface AutocompleteSuggestions {
  items: AutocompleteItem[];
  prefix: string;
}

interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}
```

---

## 实施步骤

### Phase 1: 服务端（1-2 天）

1. 添加 `autocompleteProviders` 存储
2. 实现 `addAutocompleteProvider`
3. 添加 `handleAutocompleteRequest` 方法
4. 添加 `get_autocomplete` case
5. 添加单元测试

### Phase 2: 客户端请求（1-2 天）

1. 添加 `sendAutocompleteRequest` 函数
2. 添加请求去耦和超时处理
3. 添加 `autocomplete_result` 消息监听
4. 添加单元测试

### Phase 3: 客户端弹窗（2-3 天）

1. 修改 `@` 检测支持 `@skill:`
2. 修改弹窗数据源逻辑
3. 修改弹窗渲染（扩展标记）
4. 修改键盘导航
5. 集成测试

### Phase 4: 测试和文档（1 天）

1. 端到端测试
2. 文档更新
3. 提交 PR

---

## 注意事项

1. **请求去耦：** 用户快速输入时，只发最后一次请求
2. **超时处理：** 3 秒无响应则取消
3. **错误处理：** 服务端错误不影响客户端正常输入
4. **样式兼容：** 扩展建议样式与文件建议区分
5. **性能：** 大量 provider 时注意性能（当前只调用最后一个）

---

## 后续优化

- [ ] 支持多个 trigger（`@skill:`, `@file:`, `@command:`）
- [ ] 缓存建议结果
- [ ] 支持异步加载（provider 可以异步获取数据）
- [ ] 支持自定义图标/颜色
