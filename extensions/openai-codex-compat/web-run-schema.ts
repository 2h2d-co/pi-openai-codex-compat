import { Type } from "typebox";

export type WebRunSearchQuery = {
  q: string;
  recency?: number | null;
  domains?: string[] | null;
};

export type WebRunCommands = {
  search_query?: WebRunSearchQuery[] | null;
  image_query?: WebRunSearchQuery[] | null;
  open?: Array<{
    ref_id: string;
    lineno?: number | null;
  }> | null;
  click?: Array<{
    ref_id: string;
    id: number;
  }> | null;
  find?: Array<{
    ref_id: string;
    pattern: string;
  }> | null;
  screenshot?: Array<{
    ref_id: string;
    pageno: number;
  }> | null;
  finance?: Array<{
    ticker: string;
    type: "equity" | "fund" | "crypto" | "index";
    market?: string | null;
  }> | null;
  weather?: Array<{
    location: string;
    start?: string | null;
    duration?: number | null;
  }> | null;
  sports?: Array<{
    tool?: "sports" | null;
    fn: "schedule" | "standings";
    league: "nba" | "wnba" | "nfl" | "nhl" | "mlb" | "epl" | "ncaamb" | "ncaawb" | "ipl";
    team?: string | null;
    opponent?: string | null;
    date_from?: string | null;
    date_to?: string | null;
    num_games?: number | null;
    locale?: string | null;
  }> | null;
  time?: Array<{
    utc_offset: string;
  }> | null;
  response_length?: "short" | "medium" | "long" | null;
};

/**
 * Exact post-normalization `SearchCommands` schema emitted by Codex at
 * upstream commit bb5054fe47abe73ecbbd454751066a28c89f4bb9. Codex parses the
 * generated schema through its Responses JSON-schema subset before transport,
 * which drops unsupported annotations such as `format` and `minimum`.
 */
export const WEB_RUN_PARAMETERS = Type.Unsafe<WebRunCommands>({
  type: "object",
  properties: {
    click: {
      type: "array",
      description: "Open links from previously opened pages.",
      items: {
        type: "object",
        properties: {
          id: {
            type: "integer",
            description: "Numbered link id to open.",
          },
          ref_id: {
            type: "string",
            description: "Reference id containing the numbered link.",
          },
        },
        required: ["id", "ref_id"],
      },
    },
    finance: {
      type: "array",
      description: "Look up prices for the given stock symbols.",
      items: {
        type: "object",
        properties: {
          market: {
            type: "string",
            description: 'ISO 3166-1 alpha-3 country code, "OTC", or "" for cryptocurrency.',
          },
          ticker: {
            type: "string",
            description: "Ticker symbol to look up.",
          },
          type: {
            type: "string",
            description: "Asset type to look up.",
            enum: ["equity", "fund", "crypto", "index"],
          },
        },
        required: ["ticker", "type"],
      },
    },
    find: {
      type: "array",
      description: "Find text patterns in pages.",
      items: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Text pattern to find.",
          },
          ref_id: {
            type: "string",
            description: "Reference id or URL to search within.",
          },
        },
        required: ["pattern", "ref_id"],
      },
    },
    image_query: {
      type: "array",
      description: "Query the image search engine for a given list of queries.",
      items: {
        type: "object",
        properties: {
          domains: {
            type: "array",
            description: "Whether to filter by a specific list of domains.",
            items: {
              type: "string",
            },
          },
          q: {
            type: "string",
            description: "Search query.",
          },
          recency: {
            type: "integer",
            description: "Whether to filter by recency, as a number of recent days.",
          },
        },
        required: ["q"],
      },
    },
    open: {
      type: "array",
      description: "Open pages by reference id or URL.",
      items: {
        type: "object",
        properties: {
          lineno: {
            type: "integer",
            description: "Line number to position the page at.",
          },
          ref_id: {
            type: "string",
            description: "Reference id or URL to open.",
          },
        },
        required: ["ref_id"],
      },
    },
    response_length: {
      type: "string",
      description: "Set the length of the response to be returned.",
      enum: ["short", "medium", "long"],
    },
    screenshot: {
      type: "array",
      description: "Take screenshots of PDF pages.",
      items: {
        type: "object",
        properties: {
          pageno: {
            type: "integer",
            description: "Zero-indexed PDF page number.",
          },
          ref_id: {
            type: "string",
            description: "Reference id or URL to screenshot.",
          },
        },
        required: ["pageno", "ref_id"],
      },
    },
    search_query: {
      type: "array",
      description: "Query the internet search engine for a given list of queries.",
      items: {
        type: "object",
        properties: {
          domains: {
            type: "array",
            description: "Whether to filter by a specific list of domains.",
            items: {
              type: "string",
            },
          },
          q: {
            type: "string",
            description: "Search query.",
          },
          recency: {
            type: "integer",
            description: "Whether to filter by recency, as a number of recent days.",
          },
        },
        required: ["q"],
      },
    },
    sports: {
      type: "array",
      description: "Look up sports schedules and standings.",
      items: {
        type: "object",
        properties: {
          date_from: {
            type: "string",
            description: "Start date in YYYY-MM-DD format.",
          },
          date_to: {
            type: "string",
            description: "End date in YYYY-MM-DD format.",
          },
          fn: {
            type: "string",
            description: "Sports function to call.",
            enum: ["schedule", "standings"],
          },
          league: {
            type: "string",
            description: "League to look up.",
            enum: ["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"],
          },
          locale: {
            type: "string",
            description: "Locale for the lookup.",
          },
          num_games: {
            type: "integer",
            description: "Number of games to return.",
          },
          opponent: {
            type: "string",
            description: "Opponent to use with `team` when narrowing the lookup.",
          },
          team: {
            type: "string",
            description:
              "Team to look up, using the common 3 or 4 letter alias used in broadcasts.",
          },
          tool: {
            type: "string",
            description: "Tool name for sports requests.",
            enum: ["sports"],
          },
        },
        required: ["fn", "league"],
      },
    },
    time: {
      type: "array",
      description: "Get time for the given UTC offsets.",
      items: {
        type: "object",
        properties: {
          utc_offset: {
            type: "string",
            description: 'UTC offset formatted like "+03:00".',
          },
        },
        required: ["utc_offset"],
      },
    },
    weather: {
      type: "array",
      description: "Look up weather forecasts.",
      items: {
        type: "object",
        properties: {
          duration: {
            type: "integer",
            description: "Number of days to return. Defaults to 7.",
          },
          location: {
            type: "string",
            description: 'Location in "Country, Area, City" format.',
          },
          start: {
            type: "string",
            description: "Start date in YYYY-MM-DD format. Defaults to today.",
          },
        },
        required: ["location"],
      },
    },
  },
});
