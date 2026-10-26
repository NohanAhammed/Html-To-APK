import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function out(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
    },
  });
}

function validWebsiteUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length > 2048) {
    return null;
  }

  try {
    const parsed = new URL(value.trim());

    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname.includes(".") ||
      parsed.username ||
      parsed.password ||
      (parsed.port && parsed.port !== "443") ||
      parsed.hostname === "localhost" ||
      parsed.hostname.endsWith(".localhost") ||
      parsed.hostname.endsWith(".local") ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname) ||
      parsed.hostname.includes(":")
    ) {
      return null;
    }

    return parsed.href;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return out({ error: "Method not allowed." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publicKey =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !publicKey || !serviceKey) {
    return out({ error: "Server configuration is incomplete." }, 503);
  }

  // Authenticate the user.
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return out({ error: "Sign in first." }, 401);
  }

  const userClient = createClient(supabaseUrl, publicKey, {
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: authData, error: authError } =
    await userClient.auth.getUser(token);

  if (authError || !authData.user) {
    return out({ error: "Invalid session. Please sign in again." }, 401);
  }

  // Read the submitted form.
  let form: FormData;

  try {
    form = await req.formData();
  } catch {
    return out({ error: "Expected multipart form data." }, 400);
  }

  const html = form.get("htmlFile");
  const logo = form.get("logoFile");

  let config: Record<string, unknown>;

  try {
    const rawConfig = form.get("config");
    const parsed: unknown = JSON.parse(
      typeof rawConfig === "string" ? rawConfig : "{}",
    );

    if (!isRecord(parsed)) {
      throw new Error("Invalid settings");
    }

    config = parsed;
  } catch {
    return out({ error: "Invalid app settings." }, 400);
  }

  // Accept a URL from the dedicated field or settings object.
  const rawWebsiteUrl = form.get("websiteUrl") ?? config.websiteUrl ?? "";
  let websiteUrl: string | null = null;

  if (typeof rawWebsiteUrl === "string" && rawWebsiteUrl.trim()) {
    websiteUrl = validWebsiteUrl(rawWebsiteUrl);

    if (!websiteUrl) {
      return out({
        error: "Enter a valid public HTTPS website URL.",
      }, 400);
    }
  }

  // Only one source is allowed: website URL OR HTML file.
  const hasHtml = html instanceof File && html.size > 0;
  const hasUrl = websiteUrl !== null;

  if (Number(hasHtml) + Number(hasUrl) !== 1) {
    return out({
      error: "Choose exactly one source: a website URL or an HTML file.",
    }, 400);
  }

  if (
    hasHtml &&
    (!(html instanceof File) ||
      !/\.(html|htm)$/i.test(html.name) ||
      html.size < 1 ||
      html.size > 20 * 1024 * 1024)
  ) {
    return out({
      error: "Choose an HTML file between 1 byte and 20 MB.",
    }, 400);
  }

  if (logo !== null) {
    if (
      !(logo instanceof File) ||
      !/\.png$/i.test(logo.name) ||
      logo.size < 1 ||
      logo.size > 5 * 1024 * 1024
    ) {
      return out({
        error: "App icon must be a PNG between 1 byte and 5 MB.",
      }, 400);
    }
  }

  // Validate app settings.
  const appName =
    typeof config.appName === "string" ? config.appName.trim() : "";

  const publisher =
    typeof config.publisher === "string"
      ? config.publisher.trim().slice(0, 80)
      : "";

  const version =
    typeof config.version === "string" ? config.version.trim() : "1.0.0";

  const packageId =
    typeof config.packageId === "string" ? config.packageId.trim() : "";

  if (
    !appName ||
    appName.length > 40 ||
    !/^[0-9]+(\.[0-9]+){0,3}$/.test(version) ||
    !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageId)
  ) {
    return out({
      error: "Check the app name, version, and package ID.",
    }, 400);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const jobId = crypto.randomUUID();
  const root = `inputs/${authData.user.id}/${crypto.randomUUID()}`;

  const htmlPath = hasHtml ? `${root}/index.html` : null;
  const logoPath = logo instanceof File ? `${root}/logo.png` : null;
  const uploaded: string[] = [];

  // Upload the optional HTML and logo to private Storage.
  try {
    if (html instanceof File && htmlPath) {
      const result = await admin.storage
        .from("apk-builds")
        .upload(
          htmlPath,
          new Uint8Array(await html.arrayBuffer()),
          { contentType: "text/html", upsert: false },
        );

      if (result.error) throw result.error;
      uploaded.push(htmlPath);
    }

    if (logo instanceof File && logoPath) {
      const result = await admin.storage
        .from("apk-builds")
        .upload(
          logoPath,
          new Uint8Array(await logo.arrayBuffer()),
          { contentType: "image/png", upsert: false },
        );

      if (result.error) throw result.error;
      uploaded.push(logoPath);
    }
  } catch (error) {
    if (uploaded.length) {
      await admin.storage.from("apk-builds").remove(uploaded);
    }

    console.error("Storage upload failed:", error);

    return out({
      error: "Upload failed. Check the apk-builds Storage bucket.",
    }, 500);
  }

  // Create the job using the fields read by apk-build.yml.
  const { error: insertError } = await admin
    .from("apk_build_jobs")
    .insert({
      id: jobId,
      user_id: authData.user.id,
      app_name: appName,
      publisher,
      version,
      package_id: packageId,
      fullscreen: config.fullscreen === true,
      allow_screenshots: config.allowScreenshots !== false,
      allow_internet: config.allowInternet !== false,
      include_readme: config.includeReadme !== false,
      website_url: websiteUrl,
      html_path: htmlPath,
      website_zip_path: null,
      logo_path: logoPath,
      status: "queued",
    });

  if (insertError) {
    if (uploaded.length) {
      await admin.storage.from("apk-builds").remove(uploaded);
    }

    console.error("Build job insert failed:", {
  message: insertError.message,
  code: insertError.code,
  details: insertError.details,
  hint: insertError.hint,
});

return out({
  error: "Could not create the build job.",
  details: insertError.message,
  code: insertError.code,
  hint: insertError.hint,
}, 500);

  // Dispatch the GitHub Actions workflow.
  const githubToken = Deno.env.get("GITHUB_TOKEN");
  const repository = Deno.env.get("GITHUB_REPOSITORY");

  if (
    !githubToken ||
    !repository ||
    !/^[^/]+\/[^/]+$/.test(repository)
  ) {
    await admin
      .from("apk_build_jobs")
      .update({
        status: "failed",
        error_message: "GitHub build service is not configured.",
      })
      .eq("id", jobId);

    return out({
      error: "GitHub build service is not configured.",
    }, 503);
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/actions/workflows/apk-build.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "html-apk-converter",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: { job_id: jobId },
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      console.error("GitHub dispatch failed:", response.status, detail);

      await admin
        .from("apk_build_jobs")
        .update({
          status: "failed",
          error_message: `GitHub dispatch failed (${response.status}).`,
        })
        .eq("id", jobId);

      return out({
        error: `GitHub dispatch failed (${response.status}). Check the token, repository, and workflow name.`,
      }, 502);
    }
  } catch (error) {
    console.error("GitHub dispatch request failed:", error);

    await admin
      .from("apk_build_jobs")
      .update({
        status: "failed",
        error_message: "Could not contact GitHub Actions.",
      })
      .eq("id", jobId);

    return out({ error: "Could not contact GitHub Actions." }, 502);
  }

  return out({ jobId, status: "queued" }, 202);
});
