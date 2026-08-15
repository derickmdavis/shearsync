import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { smsTemplatesService } = require("../services/smsTemplatesService") as typeof import("../services/smsTemplatesService");
const { appointmentConfirmationSmsTemplate } = require("../lib/smsTemplates") as typeof import("../lib/smsTemplates");

describe("SMS templates", () => {
  it("defines appointment_reminder as the only initial provider-neutral SMS template type", () => {
    assert.deepEqual(smsTemplatesService.listSupportedTypes(), ["appointment_reminder"]);
    assert.deepEqual(smsTemplatesService.getDefinition("appointment_reminder"), {
      type: "appointment_reminder",
      channel: "sms",
      description: "Reminder sent before a scheduled appointment.",
      requiredInputs: ["businessName", "clientFirstName", "appointmentDateTime"],
      optionalInputs: ["serviceName", "bookingManagementUrl"],
      defaultBodies: {
        withService: "{{businessName}}: Hi {{clientFirstName}}, reminder: your {{serviceName}} is {{appointmentDateTime}}. Reply STOP to opt out.",
        withoutService: "{{businessName}}: Hi {{clientFirstName}}, reminder: your appointment is {{appointmentDateTime}}. Reply STOP to opt out."
      }
    });
    assert.equal(smsTemplatesService.isSupportedType("appointment_reminder"), true);
    assert.equal(smsTemplatesService.isSupportedType("marketing"), false);
  });

  it("uses concise ASCII default appointment reminder copy with business identity and opt-out wording", () => {
    const { defaultBodies } = smsTemplatesService.getDefinition("appointment_reminder");
    for (const body of Object.values(defaultBodies)) {
      assert.match(body, /^[\x20-\x7E]+$/);
      assert.ok(body.length <= 160);
      assert.match(body, /\{\{businessName\}\}:/);
      assert.match(body, /Reply STOP to opt out\./);
    }
    assert.match(defaultBodies.withService, /\{\{serviceName\}\}/);
  });

  it("renders a separate concise appointment confirmation and includes a management link only when it fits", () => {
    const input = { businessName: "Jordan's Studio", clientFirstName: "Maya", appointmentDateTime: "Friday at 2 PM", serviceName: "haircut" };
    assert.equal(
      smsTemplatesService.renderAppointmentConfirmation(input),
      "Jordan's Studio: Hi Maya, your haircut is booked for Friday at 2 PM. Reply STOP to opt out."
    );
    assert.match(appointmentConfirmationSmsTemplate.defaultBodies.withService, /^[\x20-\x7E]+$/);
    assert.match(appointmentConfirmationSmsTemplate.defaultBodies.withService, /Reply STOP to opt out\./);
    assert.equal(
      smsTemplatesService.renderAppointmentConfirmation({ ...input, bookingManagementUrl: "https://example.com/manage" }),
      "Jordan's Studio: Hi Maya, your haircut is booked for Friday at 2 PM. Reply STOP to opt out. Manage: https://example.com/manage"
    );
    const withoutLongLink = smsTemplatesService.renderAppointmentConfirmation({ ...input, bookingManagementUrl: `https://example.com/${"a".repeat(120)}` });
    assert.equal(withoutLongLink.includes("Manage:"), false);
  });

  it("renders normalized default or custom SMS copy and rejects unsafe template input", () => {
    const input = {
      businessName: "Jordan's Studio",
      clientFirstName: "Maya",
      appointmentDateTime: "tomorrow at 2:00 PM",
      serviceName: "haircut"
    };
    assert.equal(
      smsTemplatesService.renderAppointmentReminder(input),
      "Jordan's Studio: Hi Maya, reminder: your haircut is tomorrow at 2:00 PM. Reply STOP to opt out."
    );
    assert.equal(
      smsTemplatesService.renderAppointmentReminder({ ...input, serviceName: null }, "{{businessName}}: Hi {{clientFirstName}}, see you {{appointmentDateTime}}. Reply STOP to opt out."),
      "Jordan's Studio: Hi Maya, see you tomorrow at 2:00 PM. Reply STOP to opt out."
    );
    assert.throws(() => smsTemplatesService.renderAppointmentReminder({ ...input, businessName: "" }), /requires businessName/);
    assert.throws(() => smsTemplatesService.renderAppointmentReminder({ ...input, clientFirstName: "" }), /requires clientFirstName/);
    assert.throws(() => smsTemplatesService.renderAppointmentReminder({ ...input, appointmentDateTime: "" }), /requires appointmentDateTime/);
    assert.throws(
      () => smsTemplatesService.validateSettingsPayload({ customBody: "{{businessName}} {{clientFirstName}} {{appointmentDateTime}} {{unknown}} Reply STOP to opt out." }),
      /Unsupported SMS template token/
    );
    assert.throws(
      () => smsTemplatesService.validateSettingsPayload({ customBody: "{{businessName}}: Hi {{clientFirstName}}, see you {{appointmentDateTime}}." }),
      /Reply STOP to opt out/
    );
    assert.throws(() => smsTemplatesService.validateSettingsPayload({}), /Provide enabled or customBody/);
    assert.throws(
      () => smsTemplatesService.validateSettingsPayload({ customBody: "{{businessName}}: Hi {{clientFirstName}}. Reply STOP to opt out." }),
      /must include \{\{appointmentDateTime\}\}/
    );
    assert.throws(
      () => smsTemplatesService.validateSettingsPayload({ customBody: "{{businessName}}: Your appointment is {{appointmentDateTime}}. Reply STOP to opt out." }),
      /must include \{\{clientFirstName\}\}/
    );
  });

  it("rejects non-ASCII and overlength SMS template/render output", () => {
    assert.throws(
      () => smsTemplatesService.validateSettingsPayload({ customBody: "{{businessName}}: cafe. Reply STOP to opt out. " + "e\u0301" }),
      /printable ASCII/
    );
    assert.throws(
      () => smsTemplatesService.validateSettingsPayload({ customBody: `{{businessName}}: ${"a".repeat(140)} Reply STOP to opt out.` }),
      /160 characters or fewer/
    );
    assert.throws(
      () => smsTemplatesService.renderAppointmentReminder({
        businessName: "B".repeat(120), clientFirstName: "Maya", appointmentDateTime: "tomorrow at 2 PM", serviceName: "haircut"
      }),
      /Rendered SMS must be 160 characters or fewer/
    );
    assert.throws(
      () => smsTemplatesService.renderAppointmentReminder({
        businessName: "Jose's Studio", clientFirstName: "Zo\u00eb", appointmentDateTime: "tomorrow at 2 PM", serviceName: "haircut"
      }),
      /Rendered SMS must use printable ASCII characters only/
    );
  });

  it("stores enabled account settings and falls back to default copy when custom text is absent", async () => {
    const supabase = installMockSupabase({ sms_template_settings: [] });
    try {
      const userId = "11111111-1111-1111-1111-111111111111";
      assert.deepEqual(await smsTemplatesService.getForUser(userId), {
        templateType: "appointment_reminder", enabled: true, customBody: null, configured: false, updatedAt: null
      });
      const saved = await smsTemplatesService.upsertForUser(userId, "appointment_reminder", {
        enabled: false,
        customBody: "{{businessName}}: Hi {{clientFirstName}}, see you {{appointmentDateTime}}. Reply STOP to opt out."
      });
      assert.equal(saved.enabled, false);
      assert.equal(saved.customBody, "{{businessName}}: Hi {{clientFirstName}}, see you {{appointmentDateTime}}. Reply STOP to opt out.");
      assert.equal(saved.configured, true);
      assert.deepEqual(
        await smsTemplatesService.renderAppointmentReminderForUser(userId, {
          businessName: "Jordan", clientFirstName: "Maya", appointmentDateTime: "tomorrow at 2 PM"
        }),
        { enabled: false, body: null }
      );
      await smsTemplatesService.upsertForUser(userId, "appointment_reminder", { enabled: true });
      assert.deepEqual(
        await smsTemplatesService.renderAppointmentReminderForUser(userId, {
          businessName: "Jordan", clientFirstName: "Maya", appointmentDateTime: "tomorrow at 2 PM"
        }),
        { enabled: true, body: "Jordan: Hi Maya, see you tomorrow at 2 PM. Reply STOP to opt out." }
      );
      const cleared = await smsTemplatesService.upsertForUser(userId, "appointment_reminder", { customBody: null });
      assert.equal(cleared.customBody, null);
      assert.equal(smsTemplatesService.renderAppointmentReminder({ businessName: "Jordan", clientFirstName: "Maya", appointmentDateTime: "tomorrow at 2 PM" }), "Jordan: Hi Maya, reminder: your appointment is tomorrow at 2 PM. Reply STOP to opt out.");
    } finally {
      supabase.restore();
    }
  });

  it("has no appointment queueing or Twilio dispatch surface", () => {
    const templateApi = smsTemplatesService as Record<string, unknown>;
    assert.equal("queueSms" in templateApi, false);
    assert.equal("send" in templateApi, false);
    assert.equal("processQueuedSms" in templateApi, false);
    assert.equal("createTwilioSmsProvider" in templateApi, false);
  });
});
