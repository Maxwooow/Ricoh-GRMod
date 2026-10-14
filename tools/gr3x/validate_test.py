"""Validate the exact fixed-nine candidate before giving it an update filename."""
import argparse,hashlib,json
from pathlib import Path
from adj_probe import verify as adj,verify_image_identity,CombinedGeometryProbe
from experiment_probe import verify as geometry
from liveview_probe import verify as live
from pipeline_probe import verify as pipeline
from metering_probe import verify as metering
from raw_state_probe import verify as raw_state
from shading_probe import verify as shading
from loader_probe import verify as loader
from capture_resume_probe import verify as capture_resume
from development_bounds_probe import verify as development_bounds
from chroma_alignment_probe import verify as chroma_alignment
from package_probe import verify as package
from clarity_probe import verify as clarity

if not __debug__:raise RuntimeError('Validation requires Python assertions')

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for s in ('official','container','manifest','build-report','rtos','boot','reference','output'):
        p.add_argument('--'+s,type=Path,required=True)
    p.add_argument('--base-look-manifest',type=Path)
    a=p.parse_args();a.output.mkdir()
    data=a.rtos.read_bytes();manifest=json.loads(a.manifest.read_text());build=json.loads(a.build_report.read_text())
    original=a.official.read_bytes();candidate=a.container.read_bytes()
    sha=hashlib.sha256(candidate).hexdigest()
    assert build['cameraUpdateCandidate'] and build['outputSha256']==sha
    assert build['hardwareTested'] is False and all(build['checks'].values())
    results={}
    for name,run in (
        ('adj',lambda:adj(data,manifest)),
        ('geometry',lambda:geometry(data,manifest['geometry'],CombinedGeometryProbe(data,manifest))),
        ('image-identity',lambda:verify_image_identity(data,manifest)),
        ('liveview',lambda:live(data,manifest)),
        ('development-source-bounds',lambda:development_bounds(data,manifest)),
        ('liveview-chroma-alignment',lambda:chroma_alignment(data,manifest)),
        ('face-detection-and-full-raw',lambda:capture_resume(data,manifest)),
        ('image-pipeline',lambda:pipeline(data,manifest)),
        ('metering',lambda:metering(data,manifest)),
        ('raw-and-settings',lambda:raw_state(data,manifest)),
        ('shading',lambda:shading(data,manifest)),
        ('clarity-table',lambda:clarity(data,build.get('softFocus',[]))),
        ('updater-loader',lambda:loader(data,a.boot.read_bytes(),original,candidate,build)),
        ('independent-codec',lambda:package(original,candidate,manifest,build,a.reference)),
    ):
        report=run();report['candidate_sha256']=sha
        path=a.output/(name+'.json')
        with path.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
        count=report.get('total_calls',report.get('calls',0))
        if not isinstance(count,int):raise ValueError('Unexpected call count')
        results[name]=dict(passed=True,calls=count,report=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        print(name+': passed',flush=True)
    if manifest['kind']=='gr3x-image-control-patchset':
        from image_controls_verify import verify as look_verify
        assert a.base_look_manifest is not None
        report=look_verify(data,json.loads(a.base_look_manifest.read_text()),manifest)
        report['candidate_sha256']=sha
        path=a.output/'image-controls.json'
        with path.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
        results['image-controls']=dict(passed=True,calls=report['native_calls']+report['adapter_cases'],report=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        print('image-controls: passed',flush=True)
        if 'lookTileIcon' in manifest['entries']:
            from look_icons_verify import verify as icons_verify
            report=icons_verify(data,json.loads(a.base_look_manifest.read_text()),manifest)
            report['candidate_sha256']=sha
            path=a.output/'look-icons.json'
            with path.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
            results['look-icons']=dict(passed=True,calls=report['native_calls'],report=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            print('look-icons: passed',flush=True)
    if manifest.get('jpegMetadata'):
        from jpeg_metadata_probe import verify as jpeg_verify
        report=jpeg_verify(data,manifest,a.output/'jpeg-fixtures')
        report['candidate_sha256']=sha
        path=a.output/'jpeg-metadata.json'
        with path.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
        results['jpeg-metadata']=dict(passed=True,calls=report['cases'],report=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        print('jpeg-metadata: passed',flush=True)
    summary=dict(schema=1,kind='gr3x-adj9-'+build['revision']+'-validation',candidate_sha256=sha,
                 all_checks_passed=True,checks=results,native_function_cases=sum(r['calls'] for r in results.values()),
                 container_checks=len(build['checks']),patch_sites=len(manifest['sites']),
                 hardware_tested=False,camera_io_performed=False,
                 limitations=[b for b in build['blockers'] if b!='native look-path regression suite'])
    with (a.output/'summary.json').open('x') as f:json.dump(summary,f,indent=2);f.write('\n')
    print(json.dumps(summary,indent=2))

if __name__=='__main__':main()
