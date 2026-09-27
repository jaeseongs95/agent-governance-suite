using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace Ags.Issuer.Windows.Core
{
    // B14-q-a3-2 FIXTURE harness: no pipe, token or credential secret. Reads
    // {"state":{"currentEpoch","receiverSid","callerSid"},"requests":[{"peerSid","request"}]} from stdin and writes one
    // decision per request, in order, to stdout. Unreadable input exits 2 without any decision.
    public static class Harness
    {
        public static int Main()
        {
            var json = new JavaScriptSerializer();
            Dictionary<string, object> input;
            try { input = json.DeserializeObject(Console.In.ReadToEnd()) as Dictionary<string, object>; }
            catch (ArgumentException) { input = null; }
            object state, requests;
            if (input == null || !input.TryGetValue("state", out state) || !(state is Dictionary<string, object>)
                || !input.TryGetValue("requests", out requests) || !(requests is object[]))
            {
                Console.Error.WriteLine("harness input must be {\"state\":{...},\"requests\":[...]}");
                return 2;
            }
            var record = (Dictionary<string, object>)state;
            var core = new IssuerCore(Text(record, "currentEpoch"), Text(record, "receiverSid"), Text(record, "callerSid"));
            var decisions = new List<object>();
            foreach (object item in (object[])requests)
            {
                var entry = item as Dictionary<string, object>;
                object request = null;
                if (entry != null) entry.TryGetValue("request", out request);
                decisions.Add(core.Decide(entry == null ? null : Text(entry, "peerSid"), request as Dictionary<string, object>));
            }
            Console.Out.Write(json.Serialize(decisions));
            return 0;
        }

        static string Text(Dictionary<string, object> map, string key)
        {
            object value;
            return map.TryGetValue(key, out value) ? value as string : null;
        }
    }
}
