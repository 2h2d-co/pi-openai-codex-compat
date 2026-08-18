import { Theme } from "@earendil-works/pi-coding-agent";

class TestTheme extends Theme {
  constructor() {
    super(
      {
        accent: "#ffffff",
        border: "#ffffff",
        borderAccent: "#ffffff",
        borderMuted: "#ffffff",
        success: "#ffffff",
        error: "#ffffff",
        warning: "#ffffff",
        muted: "#ffffff",
        dim: "#ffffff",
        text: "#ffffff",
        thinkingText: "#ffffff",
        userMessageText: "#ffffff",
        customMessageText: "#ffffff",
        customMessageLabel: "#ffffff",
        toolTitle: "#ffffff",
        toolOutput: "#ffffff",
        mdHeading: "#ffffff",
        mdLink: "#ffffff",
        mdLinkUrl: "#ffffff",
        mdCode: "#ffffff",
        mdCodeBlock: "#ffffff",
        mdCodeBlockBorder: "#ffffff",
        mdQuote: "#ffffff",
        mdQuoteBorder: "#ffffff",
        mdHr: "#ffffff",
        mdListBullet: "#ffffff",
        toolDiffAdded: "#ffffff",
        toolDiffRemoved: "#ffffff",
        toolDiffContext: "#ffffff",
        syntaxComment: "#ffffff",
        syntaxKeyword: "#ffffff",
        syntaxFunction: "#ffffff",
        syntaxVariable: "#ffffff",
        syntaxString: "#ffffff",
        syntaxNumber: "#ffffff",
        syntaxType: "#ffffff",
        syntaxOperator: "#ffffff",
        syntaxPunctuation: "#ffffff",
        thinkingOff: "#ffffff",
        thinkingMinimal: "#ffffff",
        thinkingLow: "#ffffff",
        thinkingMedium: "#ffffff",
        thinkingHigh: "#ffffff",
        thinkingXhigh: "#ffffff",
        thinkingMax: "#ffffff",
        bashMode: "#ffffff",
      },
      {
        selectedBg: "#282832",
        scrollbarThumb: "#282832",
        userMessageBg: "#282832",
        customMessageBg: "#282832",
        toolPendingBg: "#282832",
        toolSuccessBg: "#283228",
        toolErrorBg: "#322828",
      },
      "truecolor",
      { name: "dark" },
    );
  }

  override fg(_color: Parameters<Theme["fg"]>[0], text: string): string {
    return text;
  }

  override bold(text: string): string {
    return text;
  }

  override getBgAnsi(color: Parameters<Theme["getBgAnsi"]>[0]): string {
    return color === "toolPendingBg" ? "\u001b[48;2;40;40;50m" : "\u001b[48;2;40;50;40m";
  }

  override getColorMode(): ReturnType<Theme["getColorMode"]> {
    return "truecolor";
  }
}

export function testTheme(): Theme {
  return new TestTheme();
}
