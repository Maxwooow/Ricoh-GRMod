"""Validate the exact fixed-nine candidate before giving it an update filename."""
import argparse,hashlib,json,os
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
from adj_softfocus_probe import verify as adj_soft_focus
from datestamp_probe import verify as date_imprint
from shutdown_probe import verify as power_off_pictures
from endscreen_probe import verify as end_screen
from guard_probe import verify as settings_guard
from live_refresh_probe import verify as live_refresh
from look_layout_probe import verify as look_layout
from list_width_probe import verify as list_width

if not __debug__:raise RuntimeError('Validation requires Python assertions')

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for s in ('official','container','manifest','build-report','rtos','boot','reference','output'):
        p.add_argument('--'+s,type=Path,required=True)
    p.add_argument('--base-look-manifest',type=Path)
    p.add_argument('--halation-reference',type=Path)
    a=p.parse_args();a.output.mkdir()
    data=a.rtos.read_bytes();manifest=json.loads(a.manifest.read_text());build=json.loads(a.build_report.read_text())
    original=a.official.read_bytes();candidate=a.container.read_bytes()
    sha=hashlib.sha256(candidate).hexdigest()
    assert build['cameraUpdateCandidate'] and build['outputSha256']==sha
    assert build['hardwareTested'] is False and all(build['checks'].values())
    # The candidate's manifest must have been made from exactly this official image.
    from identity import by_container,by_rtos
    profile=by_container(original);assert by_rtos(data)==profile
    assert manifest['originalRtosSha256']==profile['rtos_sha256'] and manifest['profile']==profile['id']
    assert build['profile']==profile['id'] and build['inputSha256']==profile['container_sha256'] and build['filename']==profile['filename']
    results={}
    # GR3X_ONLY=name,name: a development re-run of some checks only (a release runs them all).
    only={x for x in os.environ.get('GR3X_ONLY','').split(',') if x}
    want=lambda name:not only or name in only
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
        *((('adj-soft-focus',lambda:adj_soft_focus(data,manifest)),) if manifest.get('adjSoftFocus') else ()),
        *((('date-imprint',lambda:date_imprint(data,manifest)),) if manifest.get('dateImprint') else ()),
        *((('power-off-pictures',lambda:power_off_pictures(data,manifest)),) if manifest.get('pictures') and manifest['pictures'].get('form')!='submenu' else ()),
        *((('end-screen-pictures',lambda:end_screen(data,manifest)),) if manifest.get('pictures') and manifest['pictures'].get('form')=='submenu' else ()),
        *((('settings-guard',lambda:settings_guard(data,manifest)),) if manifest.get('round7') else ()),
        *((('look-layout',lambda:look_layout(data,manifest)),) if manifest.get('round8') else ()),
        *((('date-style-labels',lambda:list_width(data,manifest)),) if manifest.get('round8') and manifest.get('dateImprint') else ()),
        *((('live-refresh',lambda:live_refresh(data,manifest)),) if manifest['kind']=='gr3x-image-control-patchset' and manifest.get('filmCount') else ()),
        ('updater-loader',lambda:loader(data,a.boot.read_bytes(),original,candidate,build)),
        ('independent-codec',lambda:package(original,candidate,manifest,build,a.reference)),
    ):
        if not want(name):continue
        report=run();report['candidate_sha256']=sha
        path=a.output/(name+'.json')
        with path.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
        count=report.get('total_calls',report.get('calls',0))
        if not isinstance(count,int):raise ValueError('Unexpected call count')
        results[name]=dict(passed=True,calls=count,report=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        print(name+': passed',flush=True)
    if manifest['kind']=='gr3x-image-control-patchset' and want('image-controls'):
        # Round 10: the films as looks of their own (films_r10_verify.py).
        if manifest.get('round10'):from films_r10_verify import verify as look_verify
        else:from image_controls_verify import verify as look_verify
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
    if manifest['kind']=='gr3x-image-control-patchset':
        if any(k in manifest['lookEntries'] for k in ('jpeg','postMatrix')) and want('picture-stage'):
            from picture_stage_probe import verify as stage_verify
            report=stage_verify(data,manifest,a.halation_reference)
            report['candidate_sha256']=sha
            path=a.output/'picture-stage.json'
            with path.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
            results['picture-stage']=dict(passed=True,calls=report['calls'],report=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            print('picture-stage: passed',flush=True)
        if manifest.get('ownParameters') and want('own-film-parameters'):
            if manifest.get('round10'):from films_probe import verify as slots_verify
            else:from slots_probe import verify as slots_verify
            report=slots_verify(data,manifest)
            report['candidate_sha256']=sha
            path=a.output/'own-film-parameters.json'
            with path.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
            results['own-film-parameters']=dict(passed=True,calls=report['calls'],report=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            print('own-film-parameters: passed',flush=True)
        if manifest.get('filmCount') and want('halation-screen'):
            # Round 7: the Halation and Colour rows; round 6: the Halation line.
            if manifest.get('round7'):from halation_rows_probe import verify as screen_verify
            else:from halation_screen_probe import verify as screen_verify
            report=screen_verify(data,manifest)
            report['candidate_sha256']=sha
            path=a.output/'halation-screen.json'
            with path.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
            results['halation-screen']=dict(passed=True,calls=report['calls'],report=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            print('halation-screen: passed',flush=True)
    if only:print(json.dumps({'only':sorted(only),'passed':sorted(results)}));return
    summary=dict(schema=1,kind='gr3x-adj9-'+build['revision']+'-validation',candidate_sha256=sha,
                 all_checks_passed=True,checks=results,native_function_cases=sum(r['calls'] for r in results.values()),
                 container_checks=len(build['checks']),patch_sites=len(manifest['sites']),
                 hardware_tested=False,camera_io_performed=False,
                 limitations=[b for b in build['blockers'] if b!='native look-path regression suite'])
    with (a.output/'summary.json').open('x') as f:json.dump(summary,f,indent=2);f.write('\n')
    print(json.dumps(summary,indent=2))

if __name__=='__main__':main()
