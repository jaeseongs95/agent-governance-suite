using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Ags.Issuer.Windows.Core
{
    // B14-q-a3-2: the issuer's authorization decision on parsed input, without pipe, token or credential secret.
    // Fail-closed: anything not positively allowed is refused with an ipc-frame error code. The peer SID is what the OS
    // reports for the connection (a3-3 onward); receiver and caller SIDs and the epoch come from the protected record.
    public sealed class IssuerCore
    {
        static readonly Regex Nonce = new Regex(@"^[a-f0-9]{32}\z", RegexOptions.CultureInvariant);
        static readonly Regex Id = new Regex(@"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z", RegexOptions.CultureInvariant);
        // Same shape as the a4 CANONICAL_SID: sub-authorities are 0 or [1-9][0-9]{0,9}, each at most 4294967295.
        static readonly Regex SidShape = new Regex(@"^S-1-(?:0|[1-9][0-9]{0,12})(?:-(?:0|[1-9][0-9]{0,9})){1,15}\z", RegexOptions.CultureInvariant);
        static readonly string[] RequestKeys = { "schemaVersion", "kind", "requestId", "epoch", "operation", "audience", "receiverInstance" };

        readonly string currentEpoch;
        readonly string receiverSid;
        readonly bool recordValid;
        readonly Dictionary<string, bool> seenRequestIds = new Dictionary<string, bool>(StringComparer.Ordinal);

        public IssuerCore(string currentEpoch, string receiverSid, string callerSid)
        {
            this.currentEpoch = currentEpoch;
            this.receiverSid = receiverSid;
            // A record with a malformed epoch or SID, or one that makes the caller the receiver, allows nothing.
            recordValid = IsNonce(currentEpoch) && IsCanonicalSid(receiverSid) && IsCanonicalSid(callerSid) && receiverSid != callerSid;
        }

        public static bool IsCanonicalSid(string sid)
        {
            if (sid == null || !SidShape.IsMatch(sid)) return false;
            string[] parts = sid.Split('-');
            for (int i = 3; i < parts.Length; i++)
                if (ulong.Parse(parts[i], NumberStyles.None, CultureInfo.InvariantCulture) > uint.MaxValue) return false;
            return true;
        }

        public Dictionary<string, object> Decide(string peerSid, Dictionary<string, object> request)
        {
            string requestId = Text(request, "requestId");
            string operation = Text(request, "operation");
            if (!recordValid) return Result(requestId, operation, "install-record-invalid", null);
            if (!WellFormed(request)) return Result(requestId, operation, "malformed-request", null);
            // A requestId is spent on first sight, whatever the decision.
            if (seenRequestIds.ContainsKey(requestId)) return Result(requestId, operation, "replay", null);
            seenRequestIds.Add(requestId, true);
            if (!IsCanonicalSid(peerSid)) return Result(requestId, operation, "peer-identity-rejected", null);
            if (operation == "epoch") return Result(requestId, operation, null, null);
            if (Text(request, "epoch") != currentEpoch) return Result(requestId, operation, "epoch-mismatch", null);
            string audience = Text(request, "audience");
            if (audience == "peer-receiver/v1")
            {
                // Only the recorded receiver; the caller runs as the same user as the worker and never gets one.
                if (peerSid != receiverSid) return Result(requestId, operation, "peer-identity-rejected", null);
                return Result(requestId, operation, null, new Dictionary<string, object> {
                    { "audience", audience }, { "receiverInstance", Text(request, "receiverInstance") }, { "receiverSid", receiverSid } });
            }
            // resource-caller/v1 stays fail-closed until a receiving principal is bound in the protected record (B14-l);
            // the caller is never its default receiver.
            return Result(requestId, operation, "audience-mismatch", null);
        }

        static bool WellFormed(Dictionary<string, object> request)
        {
            if (request == null) return false;
            foreach (string key in request.Keys)
                if (Array.IndexOf(RequestKeys, key) < 0) return false;
            if (Text(request, "schemaVersion") != "1.0.0" || Text(request, "kind") != "issuer-request" || !IsNonce(Text(request, "requestId"))
                || !request.ContainsKey("epoch")) return false;
            string operation = Text(request, "operation");
            if (operation == "epoch")
                return request["epoch"] == null && !request.ContainsKey("audience") && !request.ContainsKey("receiverInstance");
            string audience = Text(request, "audience");
            string receiverInstance = Text(request, "receiverInstance");
            return operation == "issue" && IsNonce(Text(request, "epoch")) && (audience == "peer-receiver/v1" || audience == "resource-caller/v1")
                && receiverInstance != null && Id.IsMatch(receiverInstance);
        }

        Dictionary<string, object> Result(string requestId, string operation, string refusal, Dictionary<string, object> grant)
        {
            var result = new Dictionary<string, object> {
                { "requestId", requestId }, { "operation", operation }, { "epoch", recordValid ? currentEpoch : null }, { "status", refusal == null ? "ok" : "rejected" } };
            if (refusal != null) result["error"] = new Dictionary<string, object> { { "code", refusal } };
            if (grant != null) result["grant"] = grant;
            return result;
        }

        static bool IsNonce(string value) { return value != null && Nonce.IsMatch(value); }

        static string Text(Dictionary<string, object> map, string key)
        {
            object value;
            return map != null && map.TryGetValue(key, out value) ? value as string : null;
        }
    }
}
