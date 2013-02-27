"""
Usage ./import.py telemetry_dump outdir/

Will produce outdir/histograms.txt, outdir/filter.json, outdir/<HISOTGRAM_NAME>.json

TODO: 

* switch from json to a binary encoding
* histograms.json should be replaced/enhanced with db schema reported by client
* include stddev, percentiles, etc where possible
"""
#!/usr/bin/python
import sys
import json

def readExisting(filename, default):
    try:
        f = open(filename)
        obj = json.loads(f.read())
        f.close()
        print "Read " + filename
        return obj
    except IOError:
        return default
    
def writeJSON(filename, obj):
    f = open(filename, 'w')
    f.write(json.dumps(obj))
    f.close()
    print "Wrote " + filename
    
f = open(sys.argv[1])
outdir = sys.argv[2]
LIMIT = 0
if len(sys.argv) > 3:
    LIMIT = int(sys.argv[3])

FILTER_JSON = "%s/filter.json" % outdir

prefix = "	{"
lineno = 0
"""

Schema: id specifying common filter values looks up list of build dates which contain

"""
# root of filter tree
root = readExisting(FILTER_JSON, {'_id':"0", 'name':'reason'})
# names for entries in filter tree
key = ['reason', 'channel', 'appName', 'appVersion', 'OS', 'osVersion', 'arch']

"""If we read-in a file from disk, need to traverse the datastructure to fix the next id to continue from"""
def findMaxId(tree, maxid):
    id = int(tree['_id'])
    if id > maxid:
        maxid = id
    for subtree in tree.values():
        if type(subtree) != dict:
            continue
        maxid = findMaxId(subtree, maxid)
    return maxid

idcount = findMaxId(root, 0) + 1

print "idcount=%d" % idcount

# schema: histogram_name {build_id:{filter_id:histogram_values},...}
histogram_data = {}

def getId(*tree_args):
    global idcount
    atm = root
    i = 0
    for pvalue in tree_args:
        i = i + 1
        try:
            atm = atm[pvalue]
        except KeyError:
            tmp = {'_id':str(idcount)}
            if i < len(key):
                tmp['name'] = key[i]
            idcount = idcount + 1
            atm[pvalue] = tmp;
            atm = tmp
    return atm


while True:
    oline = f.readline()
    if len(oline) <= 1:
        if len(oline) == 0:
            break;
        else:
            continue

    if LIMIT and lineno >= LIMIT:
        break

    lineno = lineno + 1

    # strip prefix out
    start = oline.find(prefix) + len(prefix) - 1 ;
    line = oline[start:]
    data = json.loads(line)
    i =  data['info']
    
    channel = i['appUpdateChannel']
    OS = i['OS']
    appName = i['appName']
    reason = i['reason']
    osVersion = i['version']
    appVersion = i['appVersion']
    arch = i['arch']
    buildDate = i['appBuildID'][:8]
    #print [buildDate, channel, arch]
    # todo combine OS + osVersion + santize on crazy platforms like linux to reduce pointless choices
    if OS == "Linux":
        osVersion = osVersion[:3]
    filter_obj = getId(reason, channel, appName, appVersion, OS, osVersion, arch)
    filter_id = filter_obj['_id']

    for h_name, h_values in data['histograms'].iteritems():
        try:
            histogram_forks = histogram_data[h_name]
        except KeyError:
            histogram_forks = readExisting("%s/%s.json" % (outdir, h_name), {})
            histogram_data[h_name] = histogram_forks
        
        try:
            histograms_by_build = histogram_forks[buildDate]
        except KeyError:
            histograms_by_build = {}
            histogram_forks[buildDate] = histograms_by_build

        try:
            aggr_histogram = histograms_by_build[filter_id]
        except KeyError:
            aggr_histogram = {'values':{}, 'sum':0, 'entry_count':0}
            histograms_by_build[filter_id] = aggr_histogram

        aggr_hgram_values = aggr_histogram['values']
        for bucket, bucket_value in h_values['values'].iteritems():
            try:
                aggr_hgram_values[bucket] += bucket_value
            except KeyError:
                aggr_hgram_values[bucket] = bucket_value
    
        aggr_histogram['sum'] += h_values['sum']
        aggr_histogram['entry_count'] += 1

f.close()

writeJSON(FILTER_JSON, root)

histograms_filters_key = {}
for name, filtered_dated_histogram_data in histogram_data.iteritems():
    writeJSON("%s/%s.json" % (outdir, name), filtered_dated_histogram_data)
    valid_filters = set()
    for filtered_histogram_data in filtered_dated_histogram_data.values():
        valid_filters.update(filtered_histogram_data.keys())
    histograms_filters_key[name] = list(valid_filters)

"""
TODO:
This file contains a lot similar lists of leaf filter id. This is because those histograms are filtered out on a higher level(eg OS), and all of the child nodes inherit them
There may be some optimization opportunity here to group histograms by non-leaf nodes
"""
writeJSON("%s/histograms.json" % outdir, histograms_filters_key)
    

print "%d lines decoded\n" % lineno
print [idcount]
