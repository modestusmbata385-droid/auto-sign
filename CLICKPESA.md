# AUTO SIGN payments

Production payment activation remains disabled. No real collection, payout or provider authentication probe was performed. Unit tests use mocked provider/database interfaces; the HTTP integration test runs the actual schema and SQL in PGlite's embedded PostgreSQL with mocked ClickPesa responses. It does not verify live merchant credentials or actual mobile-wallet debits.

## Parent pays both fees

The tuition balance remains `Present days × TSh 5,000 − confirmed tuition payments`.

Before consent, the server fetches a mobile payout preview for the configured recipient and a collection preview for the payer. It requires the recipient's name, phone and Airtel route to match and calculates a payout that delivers the full tuition balance, even if the merchant's payout settings deduct the fee from the beneficiary.

The parent sees tuition, collection fee, payout fee, any rounding to whole shillings, and the combined total. ClickPesa's published pricing describes collection fees as customer charges; the API principal includes tuition and payout costs, while the collection fee is displayed on top. It must not be added to the API principal again. Confirm this behavior against the actual merchant contract and a controlled live transaction before enabling general use. Mobile operator charges, where applicable, may also be shown by the operator on the payer's phone; the API does not quote those separately.

The server re-previews immediately before initiating payment. Changed amounts, fees or recipient details require new parent confirmation. Provider-query verification compares the stored API principal, client, reference, currency, final status and unique provider transaction identifiers. Only the tuition amount reduces debt. Collection and transfer fees never count as tuition or advance credit.

Confirmed collections atomically create a unique payout outbox entry. A minute worker previews again and sends at most one payout request. It checks the full recipient amount and previously accepted fees. A changed quote is held for review; an ambiguous send is queried using the same reference, never sent again. Another minute worker reconciles pending collections even when the parent page is closed. A `SUCCESS` query is required before displaying receipt by the merchant. A payout failure does not undo the parent's confirmed tuition payment.

## Configure the existing Render service

The user's requested receiver is saved in the ignored local `.env`; it is not in tracked public assets. Copy those recipient values to Render privately. Production does not read that local file.

Set these server environment variables securely in Render:

- `CLICKPESA_CLIENT_ID`, `CLICKPESA_API_KEY`, `CLICKPESA_CHECKSUM_KEY`.
- `CLICKPESA_RECIPIENT_PHONE` in `255...` format and `CLICKPESA_RECIPIENT_NAME` exactly as the provider returns it.
- `CLICKPESA_PAYOUT_FEE_MODE=parent`.
- Keep `CLICKPESA_COLLECTION_ENABLED=false` and `CLICKPESA_PAYOUT_ENABLED=false` during configuration; enable both after the deployment, recipient and merchant fee contract are verified.

Activation switches are managed on the Render service (`sync: false`) so future Blueprint syncs preserve the chosen activation state. If absent, the application defaults to disabled.

Production status on 8 November 2026: source commit `bb4cbd0` is live on `auto-sign-ajqd.onrender.com`. The requested recipient phone/name and parent-paid fee mode were saved directly to the existing service in My Workspace, preserving all other variables. Deployment `dep-dbo8r4e417fc73fis2eg` completed successfully. The Environment page confirms that Client ID, API Key and Checksum Key have not yet been configured. Both activation switches remain disabled. Provider credentials and a live transaction remain outstanding; this is not a completed live-payment integration.

The existing Tereza WiFi Site stores these credentials as secrets. Its environment API returns redacted values, so it cannot export them to Render. No Tereza settings or merchant callbacks were modified. Use an appropriate existing application with both Collection and Disbursement permissions, or create an AUTO SIGN application in the same merchant account. Do not replace Tereza or MCHANGO callbacks. Configure this application's PAYMENT RECEIVED callback to `https://<auto-sign-host>/api/clickpesa/webhook` with canonical checksum signing. If sharing an application, preserve its existing callback and add routing at that callback; do not silently overwrite it.

Existing `DATABASE_URL` and `JWT_SECRET` are still required. Startup adds payment tables and columns in the `autosign` schema. The source directory is no longer a public static directory: only browser assets are served.

Deploy the changed source on Render. On the current free Render plan the process may sleep; the minute worker runs only while the service is awake. Use an always-on service for continuous payout processing. This is an automatic two-stage collection and payout, not a direct provider split or a guaranteed instant settlement.

## Verification and recovery

Install dependencies, then run `node --test test-multiple-children.cjs test-clickpesa.cjs test-payment-flow.cjs`.

The integration test checks schema creation/reapplication, HTTP registration, child linking, attendance-based debt, cash payment subtraction, provider fee quotes, stale consent rejection, single initiation, parent isolation, signed duplicate callbacks, exact tuition credit, single payout and final recipient confirmation. It also checks that migrations preserve existing students and that source files are not served publicly. PGlite has one database connection, so multi-connection contention remains a staging verification item. Before activation, verify a small authorized live payment: parent phone debit including both fees, provider collection balance, full recipient wallet credit, one tuition ledger entry and one payout. Live verification still requires production access.

Teacher dashboards display recent payout states. `held`, `failed`, `unknown` and stale `initiating` records need investigation in ClickPesa using their saved references; do not delete them or resend money blindly. Known collection failures remain reserved for reconciliation/manual review. A process crash during a collection preview can leave a `previewing` order; verify that no push was sent before an operator resets it to `created`. There is no automatic collection-preview reset.

Official contracts checked:

- https://docs.clickpesa.com/api-reference/collection/ussd-push-requests/openapi.json
- https://docs.clickpesa.com/api-reference/collection/querying-for-payments/querying-for-payments
- https://docs.clickpesa.com/api-reference/disbursement/mno-payout/openapi.json
- https://docs.clickpesa.com/api-reference/disbursement/querying-for-payouts/openapi.json
- https://docs.clickpesa.com/home/checksum
- https://docs.clickpesa.com/home/webhooks
- https://clickpesa.com/payment-gateway/pricing/
