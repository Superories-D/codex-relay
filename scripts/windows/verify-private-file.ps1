param([Parameter(Mandatory=$true)][string]$TargetFile)
$ErrorActionPreference = 'Stop'
$full = [IO.Path]::GetFullPath($TargetFile)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = [IO.File]::GetAccessControl($full, [Security.AccessControl.AccessControlSections]'Owner,Access')
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'Private file must belong to the current user' }
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin @($sid, 'S-1-5-18')) {
    throw 'Private file grants access to another identity. Copy it into the initialized remote client credentials directory.'
  }
}
