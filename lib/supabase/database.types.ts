export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      ad_variants: {
        Row: {
          ad_id: string;
          asset_id: string | null;
          campaign_id: string;
          cost_usd: number | null;
          created_at: string;
          cta: string;
          error: string | null;
          fal_request_id: string | null;
          headline: string;
          id: string;
          model: string | null;
          parent_variant_id: string | null;
          prompt: string | null;
          status: Database["public"]["Enums"]["variant_status"];
          text_check: Json | null;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          ad_id: string;
          asset_id?: string | null;
          campaign_id: string;
          cost_usd?: number | null;
          created_at?: string;
          cta: string;
          error?: string | null;
          fal_request_id?: string | null;
          headline: string;
          id?: string;
          model?: string | null;
          parent_variant_id?: string | null;
          prompt?: string | null;
          status?: Database["public"]["Enums"]["variant_status"];
          text_check?: Json | null;
          version?: number;
        };
        Update: {
          ad_id?: string;
          asset_id?: string | null;
          campaign_id?: string;
          cost_usd?: number | null;
          created_at?: string;
          cta?: string;
          error?: string | null;
          fal_request_id?: string | null;
          headline?: string;
          id?: string;
          model?: string | null;
          parent_variant_id?: string | null;
          prompt?: string | null;
          status?: Database["public"]["Enums"]["variant_status"];
          text_check?: Json | null;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "ad_variants_ad_id_fkey";
            columns: ["ad_id"];
            isOneToOne: false;
            referencedRelation: "ads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ad_variants_asset_id_fkey";
            columns: ["asset_id"];
            isOneToOne: false;
            referencedRelation: "assets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ad_variants_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ad_variants_parent_variant_id_fkey";
            columns: ["parent_variant_id"];
            isOneToOne: false;
            referencedRelation: "ad_variants";
            referencedColumns: ["id"];
          },
        ];
      };
      ads: {
        Row: {
          angle: Database["public"]["Enums"]["ad_angle"];
          campaign_id: string;
          created_at: string;
          current_variant_id: string | null;
          id: string;
          product_id: string;
          source_asset_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          angle: Database["public"]["Enums"]["ad_angle"];
          campaign_id: string;
          created_at?: string;
          current_variant_id?: string | null;
          id?: string;
          product_id: string;
          source_asset_id?: string | null;
        };
        Update: {
          angle?: Database["public"]["Enums"]["ad_angle"];
          campaign_id?: string;
          created_at?: string;
          current_variant_id?: string | null;
          id?: string;
          product_id?: string;
          source_asset_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ads_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ads_current_variant_id_fkey";
            columns: ["current_variant_id"];
            isOneToOne: false;
            referencedRelation: "ad_variants";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ads_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ads_source_asset_id_fkey";
            columns: ["source_asset_id"];
            isOneToOne: false;
            referencedRelation: "assets";
            referencedColumns: ["id"];
          },
        ];
      };
      assets: {
        Row: {
          brand_kit_id: string;
          created_at: string;
          height: number | null;
          id: string;
          kind: Database["public"]["Enums"]["asset_kind"];
          mime: string | null;
          source_url: string | null;
          storage_path: string;
          width: number | null;
        };
        ComputedFields: never;
        Insert: {
          brand_kit_id: string;
          created_at?: string;
          height?: number | null;
          id?: string;
          kind: Database["public"]["Enums"]["asset_kind"];
          mime?: string | null;
          source_url?: string | null;
          storage_path: string;
          width?: number | null;
        };
        Update: {
          brand_kit_id?: string;
          created_at?: string;
          height?: number | null;
          id?: string;
          kind?: Database["public"]["Enums"]["asset_kind"];
          mime?: string | null;
          source_url?: string | null;
          storage_path?: string;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "assets_brand_kit_id_fkey";
            columns: ["brand_kit_id"];
            isOneToOne: false;
            referencedRelation: "brand_kits";
            referencedColumns: ["id"];
          },
        ];
      };
      brand_kits: {
        Row: {
          audience: string | null;
          claim_groups: NonNullable<Json>;
          claims: string[];
          colors: Json | null;
          created_at: string;
          domain: string;
          fonts: string[];
          id: string;
          logo_asset_id: string | null;
          name: string | null;
          owner_id: string | null;
          raw: Json | null;
          short_name: string | null;
          status: Database["public"]["Enums"]["brand_status"];
          store_url: string;
          value_prop: string | null;
          voice: Json | null;
        };
        ComputedFields: never;
        Insert: {
          audience?: string | null;
          claim_groups?: NonNullable<Json>;
          claims?: string[];
          colors?: Json | null;
          created_at?: string;
          domain: string;
          fonts?: string[];
          id?: string;
          logo_asset_id?: string | null;
          name?: string | null;
          owner_id?: string | null;
          raw?: Json | null;
          short_name?: string | null;
          status?: Database["public"]["Enums"]["brand_status"];
          store_url: string;
          value_prop?: string | null;
          voice?: Json | null;
        };
        Update: {
          audience?: string | null;
          claim_groups?: NonNullable<Json>;
          claims?: string[];
          colors?: Json | null;
          created_at?: string;
          domain?: string;
          fonts?: string[];
          id?: string;
          logo_asset_id?: string | null;
          name?: string | null;
          owner_id?: string | null;
          raw?: Json | null;
          short_name?: string | null;
          status?: Database["public"]["Enums"]["brand_status"];
          store_url?: string;
          value_prop?: string | null;
          voice?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "brand_kits_logo_asset_id_fkey";
            columns: ["logo_asset_id"];
            isOneToOne: false;
            referencedRelation: "assets";
            referencedColumns: ["id"];
          },
        ];
      };
      campaigns: {
        Row: {
          brand_kit_id: string;
          chat: NonNullable<Json>;
          created_at: string;
          goal: Database["public"]["Enums"]["campaign_goal"] | null;
          id: string;
          name: string | null;
          owner_id: string | null;
          product_ids: string[];
          source_url: string | null;
          status: Database["public"]["Enums"]["campaign_status"];
        };
        ComputedFields: never;
        Insert: {
          brand_kit_id: string;
          chat?: NonNullable<Json>;
          created_at?: string;
          goal?: Database["public"]["Enums"]["campaign_goal"] | null;
          id?: string;
          name?: string | null;
          owner_id?: string | null;
          product_ids?: string[];
          source_url?: string | null;
          status?: Database["public"]["Enums"]["campaign_status"];
        };
        Update: {
          brand_kit_id?: string;
          chat?: NonNullable<Json>;
          created_at?: string;
          goal?: Database["public"]["Enums"]["campaign_goal"] | null;
          id?: string;
          name?: string | null;
          owner_id?: string | null;
          product_ids?: string[];
          source_url?: string | null;
          status?: Database["public"]["Enums"]["campaign_status"];
        };
        Relationships: [
          {
            foreignKeyName: "campaigns_brand_kit_id_fkey";
            columns: ["brand_kit_id"];
            isOneToOne: false;
            referencedRelation: "brand_kits";
            referencedColumns: ["id"];
          },
        ];
      };
      feedback: {
        Row: {
          active: boolean;
          ad_id: string | null;
          campaign_id: string;
          created_at: string;
          id: string;
          scope: Database["public"]["Enums"]["feedback_scope"];
          text: string;
          variant_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          active?: boolean;
          ad_id?: string | null;
          campaign_id: string;
          created_at?: string;
          id?: string;
          scope: Database["public"]["Enums"]["feedback_scope"];
          text: string;
          variant_id?: string | null;
        };
        Update: {
          active?: boolean;
          ad_id?: string | null;
          campaign_id?: string;
          created_at?: string;
          id?: string;
          scope?: Database["public"]["Enums"]["feedback_scope"];
          text?: string;
          variant_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "feedback_ad_id_fkey";
            columns: ["ad_id"];
            isOneToOne: false;
            referencedRelation: "ads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "feedback_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "feedback_variant_id_fkey";
            columns: ["variant_id"];
            isOneToOne: false;
            referencedRelation: "ad_variants";
            referencedColumns: ["id"];
          },
        ];
      };
      products: {
        Row: {
          available: boolean;
          brand_kit_id: string;
          compare_at_price: number | null;
          created_at: string;
          description: string | null;
          handle: string;
          id: string;
          images: NonNullable<Json>;
          price: number;
          product_type: string | null;
          rank: number | null;
          rank_reason: string | null;
          shopify_id: number;
          tags: string[];
          title: string;
        };
        ComputedFields: never;
        Insert: {
          available?: boolean;
          brand_kit_id: string;
          compare_at_price?: number | null;
          created_at?: string;
          description?: string | null;
          handle: string;
          id?: string;
          images?: NonNullable<Json>;
          price: number;
          product_type?: string | null;
          rank?: number | null;
          rank_reason?: string | null;
          shopify_id: number;
          tags?: string[];
          title: string;
        };
        Update: {
          available?: boolean;
          brand_kit_id?: string;
          compare_at_price?: number | null;
          created_at?: string;
          description?: string | null;
          handle?: string;
          id?: string;
          images?: NonNullable<Json>;
          price?: number;
          product_type?: string | null;
          rank?: number | null;
          rank_reason?: string | null;
          shopify_id?: number;
          tags?: string[];
          title?: string;
        };
        Relationships: [
          {
            foreignKeyName: "products_brand_kit_id_fkey";
            columns: ["brand_kit_id"];
            isOneToOne: false;
            referencedRelation: "brand_kits";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      ad_angle: "benefit" | "social_proof" | "offer" | "aesthetic" | "guarantee";
      asset_kind: "logo" | "product_image" | "ad_render" | "ad_raw";
      brand_status: "researching" | "draft" | "confirmed";
      campaign_goal: "sale" | "launch" | "evergreen" | "seasonal";
      campaign_status: "briefing" | "active";
      feedback_scope: "ad" | "campaign";
      variant_status: "generating" | "draft" | "approved" | "rejected" | "failed";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      ad_angle: ["benefit", "social_proof", "offer", "aesthetic", "guarantee"],
      asset_kind: ["logo", "product_image", "ad_render", "ad_raw"],
      brand_status: ["researching", "draft", "confirmed"],
      campaign_goal: ["sale", "launch", "evergreen", "seasonal"],
      campaign_status: ["briefing", "active"],
      feedback_scope: ["ad", "campaign"],
      variant_status: ["generating", "draft", "approved", "rejected", "failed"],
    },
  },
} as const;
