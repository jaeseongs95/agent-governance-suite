using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using Ags.Issuer.Windows.Core;

namespace Ags.Issuer.Windows.Host
{
    // B14-q-a3-3b-1 FIXTURE harness: no pipe, token or credential. Reads a test envelope
    // {"state":{"currentEpoch","receiverSid","callerSid"},"peerSid","frames":["<base64 received bytes>",...]} from stdin
    // (the envelope only, never a frame, goes through JavaScriptSerializer) and writes one outcome per frame to stdout:
    // {"outcome":"response","response":"<base64>"} | {"outcome":"close"} | {"outcome":"fail-closed"}.
    // stderr carries only "outcome <kind> core-calls <n>" per frame.
    public static class FrameHarness
    {
        public static int Main()
        {
            var json = new JavaScriptSerializer();
            Dictionary<string, object> input;
            try { input = json.DeserializeObject(Console.In.ReadToEnd()) as Dictionary<string, object>; }
            catch (ArgumentException) { input = null; }
            object state, frames, peer;
            if (input == null || !input.TryGetValue("state", out state) || !(state is Dictionary<string, object>)
                || !input.TryGetValue("frames", out frames) || !(frames is object[]) || !input.TryGetValue("peerSid", out peer))
            {
                Console.Error.WriteLine("harness input must be {\"state\":{...},\"peerSid\":\"...\",\"frames\":[...]}");
                return 2;
            }
            var record = (Dictionary<string, object>)state;
            var adapter = new FrameAdapter(new IssuerCore(Text(record, "currentEpoch"), Text(record, "receiverSid"), Text(record, "callerSid")));
            var outcomes = new List<object>();
            foreach (object frame in (object[])frames)
            {
                byte[] received = Convert.FromBase64String((string)frame);
                int before = adapter.CoreCalls;
                FrameOutcome outcome = adapter.Handle(peer as string, received, received.Length);
                Console.Error.WriteLine("outcome " + outcome.Kind + " core-calls " + (adapter.CoreCalls - before));
                var entry = new Dictionary<string, object> { { "outcome", outcome.Kind } };
                if (outcome.Response != null) entry["response"] = Convert.ToBase64String(outcome.Response);
                outcomes.Add(entry);
            }
            Console.Out.Write(json.Serialize(outcomes));
            return 0;
        }

        static string Text(Dictionary<string, object> map, string key)
        {
            object value;
            return map.TryGetValue(key, out value) ? value as string : null;
        }
    }
}
