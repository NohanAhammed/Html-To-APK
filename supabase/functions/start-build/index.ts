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
  if (typeof value !== "string" || value.length > 2048) return null;

  try {
    const parsed = new URL(value.trim());

    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname.includes(".") ||
      parsed.username ||
      parsed.password ||
      parsed.port && parsed.port !== "443" ||
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return out({ error: "Method not allowed." }, 405);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const publicKey =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !publicKey || !serviceKey) {
    return out({ error: "Server configuration is incomplete." }, 503);
  }

  // Verify the user's session.
  const token = (req.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "");

  if (!token) {
    return out({ error: "Sign in first." }, 401);
  }

  const userClient = createClient(url, publicKey, {
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
    auth: { persistSession: false },
  });

  const { data: authData, error: authError } =
    await userClient.auth.getUser(token);

  if (authError || !authData.user) {
    return out({ error: "Invalid session." }, 401);
  }

  // Parse multipart form data.
  let form: FormData;

  try {
    form = await req.formData();
  } catch {
    return out({ error: "Expected multipart form data." }, 400);
  }

  const html = form.get("htmlFile");
  const zip = form.get("zipFile");
  const logo = form.get("logoFile");

  // Read the settings sent by index.html.
  let config: Record<string, unknown>;

  try {
    const rawConfig = form.get("config");
    config = JSON.parse(
      typeof rawConfig === "string" ? rawConfig : "{}",
    );

    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config)
    ) {
      throw new Error("Invalid configuration");
    }
  } catch {
    return out({ error: "Invalid app settings." }, 400);
  }

  // Accept the URL either as a separate form field or in config.
  const rawWebsiteUrl =
    form.get("websiteUrl") ?? config.websiteUrl ?? "";

  let websiteUrl: string | null = null;

  if (
    typeof rawWebsiteUrl === "string" &&
    rawWebsiteUrl.trim() !== ""
  ) {
    websiteUrl = validWebsiteUrl(rawWebsiteUrl);

    if (!websiteUrl) {
      return out({
        error: "Enter a valid public HTTPS website URL.",
      }, 400);
    }
  }

  // Require exactly one source.
  const hasHtml = html instanceof File && html.size > 0;
  const hasZip = zip instanceof File && zip.size > 0;
  const hasUrl = websiteUrl !== null;

  if (
    Number(hasHtml) +
      Number(hasZip) +
      Number(hasUrl) !==
    1
  ) {
    return out({
      error:
        "Choose exactly one source: website URL, HTML file, or ZIP file.",
    }, 400);
  }

  if (
    html instanceof File &&
    (!/\.(html|htm)$/i.test(html.name) ||
      html.size < 1 ||
      html.size > 20 * 1024 * 1024)
  ) {
    return out({
      error: "HTML must be between 1 byte and 20 MB.",
    }, 400);
  }

  if (
    zip instanceof File &&
    (!/\.zip$/i.test(zip.name) ||
      zip.size < 1 ||
      zip.size > 50 * 1024 * 1024)
  ) {
    return out({
      error: "Website ZIP must be between 1 byte and 50 MB.",
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
    typeof config.appName === "string"
      ? config.appName.trim()
      : "";

  const publisher =
    typeof config.publisher === "string"
      ? config.publisher.trim().slice(0, 80)
      : "";

  const version =
    typeof config.version === "string"
      ? config.version.trim()
      : "1.0.0";

  const packageId =
    typeof config.packageId === "string"
      ? config.packageId.trim()
      : "";

  if (
    !appName ||
    appName.length > 40 ||
    !/^[0-9]+(\.[0-9]+){0,3}$/.test(version) ||
    !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(
      packageId,
    )
  ) {
    return out({
      error: "Check app name, version, and package ID.",
    }, 400);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  const jobId = crypto.randomUUID();
  const root =
    `inputs/${authData.user.id}/${crypto.randomUUID()}`;

  const htmlPath =
    hasHtml ? `${root}/index.html` : null;

  const zipPath =
    hasZip ? `${root}/website.zip` : null;

  const logoPath =
    logo instanceof File ? `${root}/logo.png` : null;

  const uploaded: string[] = [];

  // Upload HTML, ZIP and logo files to private Storage.
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

    if (zip instanceof File && zipPath) {
      const result = await admin.storage
        .from("apk-builds")
        .upload(
          zipPath,
          new Uint8Array(await zip.arrayBuffer()),
          { contentType: "application/zip", upsert: false },
        );

      if (result.error) throw result.error;
      uploaded.push(zipPath);
    }

    if (logo instanceof File && logoPath && logo instanceof File) {
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
      error: "Upload failed. Check your Supabase Storage configuration.",
    }, 500);
  }

  // Create the build job.
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

      // Exactly one of these source fields is populated.
      website_url: websiteUrl,
      html_path: htmlPath,
      website_zip_path: zipPath,

      logo_path: logoPath,
      status: "queued",
    });

  if (insertError) {
    if (uploaded.length) {
      await admin.storage.from("apk-builds").remove(uploaded);
    }

    console.error("Build job insert failed:", insertError.message);

    return out({
      error:
        "Could not create build job. Check the apk_build_jobs database columns.",
    }, 500);
  }

  // Dispatch the existing GitHub Actions workflow.
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

  let response: Response;

  try {
    response = await fetch(
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
  } catch (error) {
    console.error("GitHub dispatch request failed:", error);

    await admin
      .from("apk_build_jobs")
      .update({
        status: "failed",
        error_message: "Could not contact GitHub Actions.",
      })
      .eq("id", jobId);

    return out({
      error: "Could not contact GitHub Actions.",
    }, 502);
  }

  if (!response.ok) {
    console.error(
      "GitHub dispatch failed:",
      response.status,
      await response.text(),
    );

    await admin
      .from("apk_build_jobs")
      .update({
        status: "failed",
        error_message: `GitHub dispatch failed (${response.status}).`,
      })
      .eq("id", jobId);

    return out({
      error:
        `GitHub dispatch failed (${response.status}). Check your GitHub token, repository settings, and workflow file.`,
    }, 502);
  }

  return out({
    jobId,
    status: "queued",
  }, 202);
});
