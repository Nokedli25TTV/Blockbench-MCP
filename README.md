# BlockbenchMCP - Blockbench Model Context Protocol Integration

BlockbenchMCP connects Blockbench to Claude AI through the Model Context Protocol (MCP), allowing Claude to directly interact with and control Blockbench. This integration enables AI-assisted 3D modeling, texture creation, and block model manipulation.

> [!IMPORTANT]
> **This is a personal, non-commercial fork — not the original project.**

## 📌 About this fork

### 🇬🇧 English

- **The original project** is **Blockbench MCP by [enfpdev](https://github.com/enfpdev)** —
  [enfp-dev-studio/blockbench-mcp](https://github.com/enfp-dev-studio/blockbench-mcp).
  The foundation of this repository (the MCP server ↔ Blockbench plugin bridge) is their work;
  all credit for it goes to them.
- Many tool definitions were ported from
  [jasonjgardner/blockbench-mcp-project](https://github.com/jasonjgardner/blockbench-mcp-project).
- I ([Nokedli25TTV](https://github.com/Nokedli25TTV)) only **extended it for my own use** —
  Minecraft / GeckoLib modding. It is **not sold, not monetized, and made without any intent of
  profit**. No support or updates are promised.
- The extensions were written **with AI assistance** (Claude Code, OpenAI Codex). They are covered
  by automated tests against a mock Blockbench and were partly tried in real Blockbench, but they
  **may still contain bugs**.
- **If you use it, you do so at your own risk:** back up your `.bbmodel` files, read the code before
  trusting it, and keep in mind that the `risky_eval` tool can run arbitrary JavaScript inside
  Blockbench.
- The project stays under the **MIT License**; the original copyright notice is kept in
  [LICENSE](LICENSE). What changed compared to the original: see the commit history and
  [ARCHITECTURE.md](ARCHITECTURE.md).

### 🇭🇺 Magyarul

- **Az eredeti projekt** a **Blockbench MCP, [enfpdev](https://github.com/enfpdev) munkája** —
  [enfp-dev-studio/blockbench-mcp](https://github.com/enfp-dev-studio/blockbench-mcp).
  Ennek a repónak az alapja (az MCP szerver ↔ Blockbench plugin híd) az ő munkájuk, minden érdem
  az övék.
- Számos tool-definíció a
  [jasonjgardner/blockbench-mcp-project](https://github.com/jasonjgardner/blockbench-mcp-project)
  projektből lett átvéve.
- Én ([Nokedli25TTV](https://github.com/Nokedli25TTV)) **csak továbbfejlesztettem saját
  felhasználásra** — Minecraft / GeckoLib modolás. **Nem árulom, nem pénzelem, semmilyen
  profitszerzési célja nincs.** Támogatást és frissítéseket nem ígérek.
- A fejlesztések **mesterséges intelligencia segítségével** készültek (Claude Code, OpenAI Codex).
  Automatikus tesztek ellenőrzik őket egy szimulált Blockbench ellen, és részben valódi
  Blockbenchben is ki lettek próbálva, de **tartalmazhatnak hibákat**.
- **Ha használod, a saját felelősségedre teszed:** készíts biztonsági mentést a `.bbmodel`
  fájljaidról, nézd át a kódot, mielőtt megbízol benne, és ne feledd, hogy a `risky_eval` tool
  tetszőleges JavaScriptet futtathat a Blockbenchben.
- A projekt továbbra is **MIT-licenc** alatt áll; az eredeti szerzői jogi közlemény a
  [LICENSE](LICENSE) fájlban megmaradt. Hogy mi változott az eredetihez képest: lásd a commit-előzményt
  és az [ARCHITECTURE.md](ARCHITECTURE.md) fájlt.

## 🚀 Features

- **Two-way communication**: Connect Claude AI to Blockbench through a socket-based server
- **Real-time command tracking**: Monitor all MCP commands with a dedicated history panel
- **Model manipulation**: Create, modify, and delete block models in Blockbench
- **Live feedback**: Get instant responses from Blockbench operations
- **Extensible architecture**: Easy to add new tools and capabilities

## 🏗️ Components

The system consists of two main components:

1. **Blockbench Plugin** (`apps/mcp-plugin`): A Blockbench plugin that creates a socket server within Blockbench to receive and execute commands
2. **MCP Server** (`apps/mcp-server`): A Node.js server that implements the Model Context Protocol and connects to the Blockbench plugin

## 📦 Project Structure

```
blockbench-mcp/
├── apps/
│   ├── mcp-server/      # MCP server implementation
│   └── mcp-plugin/      # Blockbench plugin
└── packages/
    └── shared/          # Shared TypeScript types
```

## �️ Installation

### Prerequisites

- **Blockbench** 4.0 or newer
- **Node.js** 18.0 or newer
- **pnpm** package manager

Install pnpm if you haven't already:
```bash
npm install -g pnpm
```

### 1. Clone and Setup

```bash
git clone https://github.com/Nokedli25TTV/Blockbench-MCP.git
cd Blockbench-MCP
pnpm install
```

### 2. Build the Project

```bash
pnpm build
```

### 3. Install the Blockbench Plugin

1. Build the plugin: `cd apps/mcp-plugin && pnpm build`
2. Open Blockbench
3. Go to **File** > **Plugins** > **Load Plugin from File**
4. Select the built plugin file from `apps/mcp-plugin/dist/`
5. Enable the plugin by checking the box next to "MCP Plugin"

### 4. Claude Desktop Integration

Add the following to your Claude Desktop configuration file:

**Location:**
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**Configuration:**
```json
{
  "mcpServers": {
    "blockbench": {
      "command": "node",
      "args": [
        "/path/to/blockbench-mcp/apps/mcp-server/dist/index.js"
      ]
    }
  }
}
```

## 🎮 Usage

### Starting the Connection

1. In Blockbench, open the plugin panel (if not visible, go to **View** > **Panels**)
2. Find the "MCP Plugin" panel
3. Click "Connect to MCP Server"
4. The plugin will start listening on port 9999

### Using with Claude

Once the configuration is set in Claude Desktop and the plugin is running in Blockbench, you'll see a hammer icon with tools for Blockbench MCP.

#### Capabilities

- Get model and project information
- Create, delete, and modify block models
- Apply textures and materials
- Execute custom modeling operations
- Real-time command history tracking

### Example Commands

Here are some examples of what you can ask Claude to do:

- "Create a simple sword model with proper proportions"
- "Add a crossguard to the existing sword model"
- "Create a chest model with opening animation"
- "Generate a pickaxe tool with different material variants"
- "Show me the current model structure and elements"
- "Create a character head with facial features"

## 🔧 Development

### Development Mode

```bash
# Start both server and plugin in development mode
pnpm dev

# Or start individually
cd apps/mcp-server && pnpm dev
cd apps/mcp-plugin && pnpm dev
```

### Version Management

This project uses [Changesets](https://github.com/changesets/changesets) for version management:

```bash
# Record changes
pnpm changeset

# Update versions
pnpm version

# Build all packages
pnpm build
```

## 🐛 Troubleshooting

- **Connection issues**: Make sure the Blockbench plugin is running and the MCP server is configured in Claude Desktop
- **Port conflicts**: The plugin uses port 9999 by default. Make sure no other application is using this port
- **Plugin not loading**: Verify that the plugin file is properly built and Blockbench version is compatible
- **Command timeouts**: Try simplifying your requests or breaking them into smaller steps

## 🔧 Technical Details

### Communication Protocol

The system uses Socket.IO for real-time communication between components:

- **WebSocket connection** on port 9999
- **JSON-based commands** with type and payload structure
- **Event-driven architecture** for responsive interactions

### Architecture

```
Claude AI ← MCP Protocol → MCP Server ← Socket.IO → Blockbench Plugin
```

## ⚠️ Limitations & Security Considerations

- The plugin allows executing code within Blockbench, which can be powerful but potentially risky
- Always save your work before using experimental features
- Complex operations might need to be broken down into smaller steps
- Network communication happens over localhost only for security

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## � License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Original project: [enfp-dev-studio/blockbench-mcp](https://github.com/enfp-dev-studio/blockbench-mcp) by [enfpdev](https://github.com/enfpdev)
- Tool definitions ported from [jasonjgardner/blockbench-mcp-project](https://github.com/jasonjgardner/blockbench-mcp-project)
- Inspired by [BlenderMCP](https://github.com/ahujasid/blender-mcp)
- Built with the [Model Context Protocol](https://modelcontextprotocol.io/)
- Thanks to the Blockbench community for the amazing 3D modeling tool

---

**Disclaimer:** This is a third-party integration and not officially affiliated with Blockbench.
