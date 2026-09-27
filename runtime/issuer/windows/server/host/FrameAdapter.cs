using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using Ags.Issuer.Windows.Core;

namespace Ags.Issuer.Windows.Host
{
    public sealed class FrameOutcome
    {
        public string Kind;      // "response", "close" or "fail-closed"
        public byte[] Response;  // only for "response": one ipc-frame.v1 response and its LF
    }

    // B14-q-a3-3b-1: one request frame in, one ipc-frame.v1 response or a bounded close out (FIXTURE; no pipe or token).
    // A frame is the bytes before the first LF; with its LF it is at most MaxFrameBytes, so a reader never needs more than
    // MaxFrameBytes + 1 bytes. Anything the restricted parser refuses is closed without calling the core. The core's
    // internal decision is never sent: only schemaVersion, kind, requestId, operation, epoch, status and error.code are
    // written, and an allowed issue is "unavailable" because no credential producer exists yet (B14-l).
    public sealed class FrameAdapter
    {
        public const int MaxFrameBytes = 4096;
        static readonly Encoding StrictUtf8 = new UTF8Encoding(false, true);
        static readonly string[] Codes = { "peer-identity-rejected", "replay", "epoch-mismatch", "malformed-request", "audience-mismatch" };
        readonly IssuerCore core;
        public int CoreCalls;

        public FrameAdapter(IssuerCore core) { this.core = core; }

        public FrameOutcome Handle(string peerSid, byte[] received, int length)
        {
            int end = Array.IndexOf(received, (byte)'\n', 0, Math.Min(length, MaxFrameBytes));
            // No LF within the cap (too long or unterminated), or bytes after it: the frame boundary is broken.
            if (end < 0 || end + 1 != length) return Close();
            Dictionary<string, object> request;
            try { request = RequestParser.Parse(StrictUtf8.GetString(received, 0, end)); }
            catch (DecoderFallbackException) { return Close(); }
            catch (FormatException) { return Close(); }
            CoreCalls++;
            Dictionary<string, object> decision = core.Decide(peerSid, request);
            string epoch = decision["epoch"] as string;
            // An invalid install record has no epoch: send nothing rather than invent one.
            if (!IsNonce(epoch)) return new FrameOutcome { Kind = "fail-closed" };
            string requestId = decision["requestId"] as string;
            string operation = decision["operation"] as string;
            // Only an exact requestId and operation are echoed; otherwise nothing is invented.
            if (!IsNonce(requestId) || (operation != "epoch" && operation != "issue")) return Close();
            object error;
            string code = decision.TryGetValue("error", out error) ? ((Dictionary<string, object>)error)["code"] as string : null;
            string status = "ok";
            if (code != null)
            {
                if (Array.IndexOf(Codes, code) < 0) return new FrameOutcome { Kind = "fail-closed" };
                status = "rejected";
            }
            else if (operation == "issue")
            {
                status = "unavailable";
                code = "service-unavailable";
            }
            var text = new StringBuilder("{\"schemaVersion\":\"1.0.0\",\"kind\":\"issuer-response\",\"requestId\":\"").Append(requestId)
                .Append("\",\"operation\":\"").Append(operation).Append("\",\"epoch\":\"").Append(epoch)
                .Append("\",\"status\":\"").Append(status).Append('"');
            if (code != null) text.Append(",\"error\":{\"code\":\"").Append(code).Append("\"}");
            text.Append("}\n");
            return new FrameOutcome { Kind = "response", Response = Encoding.ASCII.GetBytes(text.ToString()) };
        }

        static FrameOutcome Close() { return new FrameOutcome { Kind = "close" }; }

        static bool IsNonce(string value)
        {
            if (value == null || value.Length != 32) return false;
            foreach (char c in value)
                if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')) return false;
            return true;
        }
    }

    // A restricted parser for the current issuer request only, not a general JSON parser: one object whose values are JSON
    // strings or null (the ipc-frame request shape). Other value types are outside the request format; they, duplicate
    // names (compared after unescaping), trailing content and bad escapes throw FormatException.
    static class RequestParser
    {
        public static Dictionary<string, object> Parse(string text)
        {
            int i = 0;
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            Skip(text, ref i);
            Expect(text, ref i, '{');
            Skip(text, ref i);
            if (i < text.Length && text[i] == '}') i++;
            else
                while (true)
                {
                    Skip(text, ref i);
                    string name = ReadString(text, ref i);
                    Skip(text, ref i);
                    Expect(text, ref i, ':');
                    Skip(text, ref i);
                    object value;
                    if (i < text.Length && text[i] == '"') value = ReadString(text, ref i);
                    else if (string.CompareOrdinal(text, i, "null", 0, 4) == 0) { value = null; i += 4; }
                    else throw new FormatException("a request value is a string or null");
                    if (result.ContainsKey(name)) throw new FormatException("duplicate name");
                    result.Add(name, value);
                    Skip(text, ref i);
                    char next = Next(text, ref i);
                    if (next == '}') break;
                    if (next != ',') throw new FormatException("expected , or }");
                }
            Skip(text, ref i);
            if (i != text.Length) throw new FormatException("trailing content");
            return result;
        }

        static string ReadString(string text, ref int i)
        {
            Expect(text, ref i, '"');
            var value = new StringBuilder();
            while (true)
            {
                char c = Next(text, ref i);
                if (c == '"') return value.ToString();
                if (c < 0x20) throw new FormatException("control character in a string");
                if (c != '\\') { value.Append(c); continue; }
                char escape = Next(text, ref i);
                switch (escape)
                {
                    case '"': case '\\': case '/': value.Append(escape); break;
                    case 'b': value.Append('\b'); break;
                    case 'f': value.Append('\f'); break;
                    case 'n': value.Append('\n'); break;
                    case 'r': value.Append('\r'); break;
                    case 't': value.Append('\t'); break;
                    case 'u':
                        char unit = Hex4(text, ref i);
                        if (char.IsHighSurrogate(unit))
                        {
                            Expect(text, ref i, '\\');
                            Expect(text, ref i, 'u');
                            char low = Hex4(text, ref i);
                            if (!char.IsLowSurrogate(low)) throw new FormatException("lone surrogate escape");
                            value.Append(unit).Append(low);
                        }
                        else if (char.IsLowSurrogate(unit)) throw new FormatException("lone surrogate escape");
                        else value.Append(unit);
                        break;
                    default: throw new FormatException("bad escape");
                }
            }
        }

        static char Hex4(string text, ref int i)
        {
            int unit;
            if (i + 4 > text.Length || !int.TryParse(text.Substring(i, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out unit))
                throw new FormatException("bad \\u escape");
            i += 4;
            return (char)unit;
        }

        static void Skip(string text, ref int i)
        {
            while (i < text.Length && (text[i] == ' ' || text[i] == '\t' || text[i] == '\n' || text[i] == '\r')) i++;
        }

        static char Next(string text, ref int i)
        {
            if (i >= text.Length) throw new FormatException("unexpected end");
            return text[i++];
        }

        static void Expect(string text, ref int i, char expected)
        {
            if (Next(text, ref i) != expected) throw new FormatException("expected " + expected);
        }
    }
}
